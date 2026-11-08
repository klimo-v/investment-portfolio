import Decimal from 'decimal.js';
import { normalizeNumber, type RawRow } from './import';

/**
 * Нерублёвые деньги при импорте (П3). Кэш приложения — только рублёвый, а валюта на счёте —
 * это ПОЗИЦИЯ (покупка CNYRUB_TOM уже создаёт позицию Currency). Поэтому пополнение валютой
 * разворачивается в две обычные операции: Deposit (та же сумма и валюта, заполненный курс) +
 * Buy валютной пары на то же количество по тому же курсу; вывод валюты — зеркально (Sell, затем
 * Withdraw). Все расчёты (позиции, сделки, кэш, ряд) работают без изменений: один факт — две
 * обычные операции, мультивалютный кэш не нужен.
 *
 * Чистая функция: курсы приходят снаружи (`ForeignCashLookups`), сеть и БД ей неизвестны.
 */

/** Валютная пара на бирже по коду валюты (режим CETS, торги «сегодня»; тикер — как в брокерских отчётах) */
export const CURRENCY_PAIR_TICKER: Record<string, string> = {
  CNY: 'CNYRUB_TOM',
  USD: 'USD000UTSTOM',
  EUR: 'EUR_RUB__TOM',
};

/** Продажа валюты за день: количество и цена в рублях */
export interface DaySale {
  quantity: string;
  price: string;
}

export interface ForeignCashLookups {
  /** курс ЦБ на дату (₽ за 1 единицу валюты, последний ≤ даты); null — курса нет */
  cbrRate: (currency: string, date: string) => string | null;
  /** продажи этой валютной пары в журнале (БД) за тот же день — чтобы курс не менялся от загрузки к загрузке */
  journalSales?: (pairTicker: string, date: string) => DaySale[];
}

const DEPOSIT_TYPES = new Set(['deposit', 'ввод', 'пополнение']);
const WITHDRAW_TYPES = new Set(['withdraw', 'вывод']);

/** Первая/последняя секунда дня: конвертация обязана встать раньше (покупка) / позже (продажа) других операций дня */
const DAY_START = '00:00:00';
const DAY_END = '23:59:59';

export type ForeignRateSource = 'same-day-sale' | 'cbr';

const isSell = (r: RawRow): boolean => ['sell', 'продажа'].includes((r.tradeType ?? '').trim().toLowerCase());

/**
 * Курс для нерублёвой кэш-операции — правило одно:
 *  1) есть продажа этой валюты в тот же день (в этой загрузке или в журнале) → средневзвешенная
 *     цена продажи: деньги прошли транзитом, курсовой разницы нет (курс ЦБ или закрытия дал бы
 *     фиктивную прибыль);
 *  2) иначе — курс ЦБ на дату.
 * null — курса нет (вызывающий превращает это в ошибку предпросмотра, а не в молчаливую единицу).
 */
export function foreignCashRate(
  currency: string,
  date: string,
  rows: readonly RawRow[],
  lookups: ForeignCashLookups,
): { rate: string; source: ForeignRateSource } | null {
  const pair = CURRENCY_PAIR_TICKER[currency];
  if (pair) {
    const sales: DaySale[] = rows
      .filter((r) => r.ticker === pair && r.date === date && isSell(r))
      .map((r) => ({ quantity: normalizeNumber(r.quantity, '0'), price: normalizeNumber(r.price, '0') }));
    sales.push(...(lookups.journalSales?.(pair, date) ?? []));
    const qty = sales.reduce((s, x) => s.plus(x.quantity), new Decimal(0));
    if (qty.gt(0)) {
      const sum = sales.reduce((s, x) => s.plus(new Decimal(x.quantity).mul(x.price)), new Decimal(0));
      return { rate: sum.div(qty).toDecimalPlaces(8).toFixed(), source: 'same-day-sale' };
    }
  }
  const cbr = lookups.cbrRate(currency, date);
  return cbr ? { rate: cbr, source: 'cbr' } : null;
}

/** У всех продаж пары за день в загрузке есть время (иначе нулевое время конвертации встало бы позже них) */
function sameDaySalesHaveTime(rows: readonly RawRow[], pair: string, date: string): boolean {
  return rows.filter((r) => r.ticker === pair && r.date === date && isSell(r)).every((r) => !!r.time);
}

/**
 * Разворачивает нерублёвые деньги и проставляет обязательный `fxRate`:
 *  - Deposit/Withdraw в валюте → пара операций с общим `transferGroup`, вторая — `brokerRef` = `{id}:fx`
 *    (повторный импорт ничего не удваивает: дедупликация по brokerRef);
 *  - прочие нерублёвые строки без `fxRate` → курс ЦБ на дату;
 *  - нет курса или валютной пары → строка с `skipReason` (ошибка предпросмотра).
 */
export function expandForeignCash(rows: RawRow[], lookups: ForeignCashLookups): RawRow[] {
  const out: RawRow[] = [];
  for (const raw of rows) {
    const currency = (raw.currency ?? 'RUB').trim().toUpperCase();
    if (currency === 'RUB' || raw.skipReason) {
      out.push(raw);
      continue;
    }
    const type = (raw.tradeType ?? '').trim().toLowerCase();
    const isDeposit = DEPOSIT_TYPES.has(type);
    const isWithdraw = WITHDRAW_TYPES.has(type);
    const found = foreignCashRate(currency, raw.date, rows, lookups);

    if (!isDeposit && !isWithdraw) {
      if (raw.fxRate) out.push(raw);
      else out.push(found ? { ...raw, fxRate: found.rate } : { ...raw, skipReason: `Нет курса ${currency} на ${raw.date}: загрузите историю курсов ЦБ` });
      continue;
    }

    const pair = CURRENCY_PAIR_TICKER[currency];
    if (!pair || !found) {
      out.push({
        ...raw,
        skipReason: !pair
          ? `Нет валютной пары для ${currency}: ${isDeposit ? 'пополнение' : 'вывод'} в этой валюте не поддержан`
          : `Нет курса ${currency} на ${raw.date}: загрузите историю курсов ЦБ`,
      });
      continue;
    }

    const amount = new Decimal(normalizeNumber(raw.quantity, '1')).mul(normalizeNumber(raw.price, '0')).abs();
    const group = `fx:${raw.brokerRef ?? `${raw.date}:${currency}:${amount.toFixed()}`}`;
    // конвертация встаёт раньше продажи того же дня (иначе продажа окажется без позиции)
    const convertTime = isDeposit
      ? found.source === 'same-day-sale' && !sameDaySalesHaveTime(rows, pair, raw.date)
        ? undefined
        : DAY_START
      : DAY_END;

    const cash: RawRow = { ...raw, fxRate: found.rate, transferGroup: group };
    const conversion: RawRow = {
      date: raw.date,
      time: convertTime,
      system: raw.system,
      ticker: pair,
      instrumentType: 'Currency',
      currency: 'RUB',
      tradeType: isDeposit ? 'buy' : 'sell',
      quantity: amount.toFixed(),
      price: found.rate,
      fee: '0',
      note: `${isDeposit ? 'Покупка' : 'Продажа'} ${currency} при ${isDeposit ? 'пополнении' : 'выводе'} валютой по курсу ${found.rate} (${found.source === 'cbr' ? 'ЦБ' : 'сделка дня'})`,
      accountRef: raw.accountRef,
      brokerRef: raw.brokerRef ? `${raw.brokerRef}:fx` : undefined,
      transferGroup: group,
    };
    out.push(...(isDeposit ? [cash, conversion] : [conversion, cash]));
  }
  return out;
}
