import Decimal from 'decimal.js';
import type { Operation } from './schemas';

/**
 * Полнота журнала: невидимые пропуски, которые тихо портят доходность. Если Coupon не
 * импортирован — результат занижен; если не внесён Deposit — довнесение выглядит как прибыль,
 * а кэш уходит в минус. Метрики не блокируются, но пользователь видит список и пометку на карточке.
 *
 * Чистая функция: расписание купонов приходит аргументом (его грузит провайдер в apps/api, там
 * же кэш), кэш по дням — из ряда valuationSeries (cashSeries). Проверка дивидендов по расписанию
 * пока не делается: у MOEX ISS эндпоинт /iss/securities/{SECID}/dividends.json отдаёт
 * только описание бумаги и режимы торгов, без блока дивидендов (проверено на SBER, X5, LKOH) —
 * придумывать источник не будем.
 */

Decimal.set({ precision: 40 });

/**
 * Пороги проверок — в одном месте.
 *  - PAYOUT_WINDOW_DAYS: сколько дней после даты выплаты ждём Coupon-операцию. Брокер зачисляет в
 *    день выплаты или на 1–3 рабочих дня позже, отчёт и импорт — ещё позже; 10 дней — запас.
 *  - EARLY_TOLERANCE_DAYS: операция чуть РАНЬШЕ даты выплаты тоже засчитывается (даты у брокера
 *    и биржи расходятся на день-два).
 *  - RECORD_GRACE_DAYS: держали ли бумагу, смотрим и на дату фиксации, и на RECORD_GRACE_DAYS раньше —
 *    сделка в последние дни перед фиксацией (расчёты T+1) не должна давать ложное предупреждение.
 *  - NO_RECORD_DATE_OFFSET_DAYS: см. ниже.
 *  - MIN_NEGATIVE_CASH_RUB: отрицательный кэш меньше этой суммы считаем шумом округления.
 */
export const COMPLETENESS = {
  PAYOUT_WINDOW_DAYS: 10,
  EARLY_TOLERANCE_DAYS: 3,
  RECORD_GRACE_DAYS: 2,
  /**
   * Биржа не указала дату фиксации: реестр закрывается за 1–2 рабочих дня до выплаты, поэтому считаем её на
   * этот срок раньше выплаты — бумага, проданная до реестра, купон не получает и ложного предупреждения не даёт.
   */
  NO_RECORD_DATE_OFFSET_DAYS: 3,
  MIN_NEGATIVE_CASH_RUB: 1,
} as const;

/** Купон из графика выплат биржи */
export interface CouponScheduleRow {
  instrumentId: string;
  /** дата выплаты */
  couponDate: string;
  /** дата фиксации реестра; null — биржа не указала (берём дату выплаты) */
  recordDate: string | null;
  /** купон на одну бумагу, ₽ (справочно — для подсказки ожидаемой суммы) */
  amountRub: string | null;
}

export type CompletenessKind = 'missing-coupon' | 'negative-cash';

export interface CompletenessWarning {
  kind: CompletenessKind;
  instrumentId: string | null;
  ticker: string | null;
  /** дата события: выплаты или первый день отрицательного кэша */
  date: string;
  /** последний день отрицательного кэша; для купона null */
  dateTo: string | null;
  /** ожидаемая выплата или худший отрицательный остаток, ₽ */
  amountRub: string | null;
  message: string;
}

export interface CompletenessInput {
  operations: readonly Operation[];
  schedules: readonly CouponScheduleRow[];
  /** кэш по дням (cashSeries) вместе с датами; undefined — у контура нет своего кэша (система) */
  cash?: readonly { date: string; cashRub: string }[];
  tickers: ReadonlyMap<string, string>;
  /** сегодня: купоны, срок ожидания которых ещё не вышел, не проверяем */
  today: string;
}

const DAY_MS = 86_400_000;

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

const fmtRub = (v: Decimal): string => v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';

/** Количество бумаги на конец дня `date` по её сделкам (покупки − продажи) */
function heldOn(trades: readonly Operation[], date: string): Decimal {
  let qty = new Decimal(0);
  for (const o of trades) {
    if (o.date > date) continue;
    qty = o.operationType === 'Buy' ? qty.plus(o.quantity) : qty.minus(o.quantity);
  }
  return qty;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function journalCompleteness(input: CompletenessInput): CompletenessWarning[] {
  const warnings: CompletenessWarning[] = [];
  const name = (id: string): string => input.tickers.get(id) ?? id;

  // 1. Купон по графику биржи: бумага удерживалась на дату фиксации, а Coupon-операции нет.
  //    Операции индексируем по бумаге — график × журнал без перебора всего журнала на каждый купон.
  const trades = new Map<string, Operation[]>();
  const couponsByInstrument = new Map<string, Operation[]>();
  const unattributed: { op: Operation; used: boolean }[] = [];
  for (const o of input.operations) {
    if (o.operationType === 'Coupon') {
      if (!o.instrumentId) unattributed.push({ op: o, used: false });
      else push(couponsByInstrument, o.instrumentId, o);
    } else if (o.instrumentId && (o.operationType === 'Buy' || o.operationType === 'Sell')) {
      push(trades, o.instrumentId, o);
    }
  }
  const schedules = [...input.schedules].sort((a, b) => a.couponDate.localeCompare(b.couponDate));
  for (const row of schedules) {
    const own = trades.get(row.instrumentId);
    if (!own) continue;
    // срок ожидания ещё не вышел — рано судить
    if (addDays(row.couponDate, COMPLETENESS.PAYOUT_WINDOW_DAYS) > input.today) continue;
    const recordDate = row.recordDate ?? addDays(row.couponDate, -COMPLETENESS.NO_RECORD_DATE_OFFSET_DAYS);
    // держали и ДО фиксации (с запасом — сделка перед реестром ещё не рассчитана), и НА дату фиксации
    // (проданное накануне уходит с расчётом T+1 до реестра — купон уже не положен)
    const qtyBefore = heldOn(own, addDays(recordDate, -COMPLETENESS.RECORD_GRACE_DAYS));
    const qtyAt = heldOn(own, recordDate);
    const qty = qtyBefore.lt(qtyAt) ? qtyBefore : qtyAt;
    if (!qty.gt(0)) continue;
    const from = addDays(row.couponDate, -COMPLETENESS.EARLY_TOLERANCE_DAYS);
    const till = addDays(row.couponDate, COMPLETENESS.PAYOUT_WINDOW_DAYS);
    const inWindow = (o: Operation): boolean => o.date >= from && o.date <= till;
    if ((couponsByInstrument.get(row.instrumentId) ?? []).some(inWindow)) continue;
    // купон без привязки к бумаге (в журнале так бывает) тоже закрывает выплату — по одному на выплату,
    // чтобы одна неатрибутированная операция не гасила предупреждения сразу по нескольким бумагам
    const loose = unattributed.find((u) => !u.used && inWindow(u.op));
    if (loose) {
      loose.used = true;
      continue;
    }
    const expected = row.amountRub ? qty.mul(row.amountRub) : null;
    warnings.push({
      kind: 'missing-coupon',
      instrumentId: row.instrumentId,
      ticker: name(row.instrumentId),
      date: row.couponDate,
      dateTo: null,
      amountRub: expected ? expected.toFixed(2) : null,
      message:
        `${name(row.instrumentId)}: купон ${row.couponDate} по графику биржи` +
        (expected ? ` (≈ ${fmtRub(expected)} на ${qty.toString()} шт.)` : '') +
        `, но операции «Купон» в журнале нет — выплата не импортирована, результат занижен.`,
    });
  }

  // 2. Кэш ушёл ниже нуля: в журнале не хватает ввода денег (пополнений, переводов)
  if (input.cash && input.cash.length > 0) {
    let first: string | null = null;
    let last = '';
    let worst = new Decimal(0);
    let days = 0;
    for (const c of input.cash) {
      const v = new Decimal(c.cashRub);
      if (v.lt(-COMPLETENESS.MIN_NEGATIVE_CASH_RUB)) {
        first ??= c.date;
        last = c.date;
        days++;
        if (v.lt(worst)) worst = v;
      }
    }
    if (first) {
      warnings.push({
        kind: 'negative-cash',
        instrumentId: null,
        ticker: null,
        date: first,
        dateTo: last,
        amountRub: worst.toFixed(2),
        message:
          `Кэш по журналу уходит ниже нуля (${days} дн., с ${first}, худший остаток ${fmtRub(worst)}): ` +
          `не хватает пополнений или переводов — довнесение выглядит как прибыль, доходность искажена.`,
      });
    }
  }

  return warnings.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

/** Задевает ли предупреждение период [from, till] (границы необязательны) */
export function warningTouchesPeriod(w: CompletenessWarning, from: string | null | undefined, till: string): boolean {
  return w.date <= till && (w.dateTo ?? w.date) >= (from ?? '0000-00-00');
}
