import Decimal from 'decimal.js';
import type { RawRow } from '../import';

/**
 * Маппер ответов T-Invest API (метод `OperationsService/GetOperationsByCursor`)
 * в общий формат `RawRow` (CLAUDE.md §7, OCP: новый источник = новый «парсер»,
 * конвейер импорта ниже не меняется).
 *
 * Функция чистая и не тянет Node-зависимостей — поэтому живёт в `libs/core`
 * рядом с `broker-html-report.ts` и тестируется фикстурами. HTTP-клиент,
 * пагинация и токен — на бэке (`apps/api/.../import/tbank/`).
 *
 * Соглашения намеренно совпадают с XLSX-парсером отчёта Т-Банка
 * (`apps/api/.../import/tbank-xlsx-report.ts`): цена — за единицу и БЕЗ НКД,
 * выплаты — нетто (за вычетом налога), `brokerRef` сделки — её биржевой номер.
 * Это не косметика: по `brokerRef` работает дедупликация (`makeDedupeKey`),
 * поэтому сделка, уже импортированная из XLSX-отчёта, обязана дать тот же ключ
 * при импорте через API — иначе вся история задвоится.
 */

/** Денежная величина T-Invest API: целая часть строкой + наноединицы */
export interface TbankMoneyValue {
  currency?: string;
  units?: string;
  nano?: number;
}

/** Одна сделка внутри операции (частичное исполнение заявки) */
export interface TbankOperationTrade {
  /** Номер сделки на бирже — он же «Номер сделки» в XLSX-отчёте */
  num?: string;
  /** То же поле в ответах старого метода GetOperations */
  tradeId?: string;
  date?: string;
  quantity?: string;
  price?: TbankMoneyValue;
}

/** Элемент ответа GetOperationsByCursor */
export interface TbankOperationItem {
  id?: string;
  /** Ссылка на родительскую операцию: так налог связан со своим дивидендом */
  parentOperationId?: string;
  date?: string;
  /** Машинный тип операции, напр. OPERATION_TYPE_BUY */
  type?: string;
  /** Человекочитаемое описание от брокера */
  description?: string;
  state?: string;
  instrumentUid?: string;
  figi?: string;
  /** share | bond | etf | currency | futures | … */
  instrumentType?: string;
  payment?: TbankMoneyValue;
  price?: TbankMoneyValue;
  commission?: TbankMoneyValue;
  /** НКД по облигации — в цену НЕ входит (как и в XLSX-отчёте) */
  accruedInt?: TbankMoneyValue;
  quantity?: string;
  tradesInfo?: { trades?: TbankOperationTrade[] };
}

/** Справочные поля инструмента (InstrumentsService/GetInstrumentBy) */
export interface TbankInstrumentRef {
  ticker?: string;
  isin?: string;
  name?: string;
  currency?: string;
  instrumentType?: string;
}

/**
 * Типы операций брокера → ключи, которые уже понимает `classifyOperationType`
 * (`libs/core/src/lib/import.ts`). Намеренно НЕ полный: неизвестный тип не
 * маппится, а пробрасывается как есть и подсвечивается в предпросмотре как
 * `warn` — так новые типы операций у брокера видно, а не молча превращаются
 * в «покупку».
 */
const OPERATION_TYPE_MAP: Record<string, string> = {
  OPERATION_TYPE_BUY: 'buy',
  OPERATION_TYPE_BUY_CARD: 'buy',
  OPERATION_TYPE_BUY_MARGIN: 'buy',
  OPERATION_TYPE_SELL: 'sell',
  OPERATION_TYPE_SELL_CARD: 'sell',
  OPERATION_TYPE_SELL_MARGIN: 'sell',
  OPERATION_TYPE_INPUT: 'deposit',
  OPERATION_TYPE_OUTPUT: 'withdraw',
  OPERATION_TYPE_DIVIDEND: 'dividend',
  OPERATION_TYPE_COUPON: 'coupon',
  // погашение облигации приходит деньгами на счёт, как и купон
  OPERATION_TYPE_BOND_REPAYMENT: 'coupon',
  OPERATION_TYPE_BOND_REPAYMENT_FULL: 'coupon',
  OPERATION_TYPE_TAX: 'tax',
  OPERATION_TYPE_TAX_CORRECTION: 'tax',
  OPERATION_TYPE_DIVIDEND_TAX: 'tax',
  OPERATION_TYPE_DIVIDEND_TAX_PROGRESSIVE: 'tax',
  OPERATION_TYPE_COUPON_TAX: 'tax',
  OPERATION_TYPE_BOND_TAX: 'tax',
  OPERATION_TYPE_BROKER_FEE: 'fee',
  OPERATION_TYPE_SERVICE_FEE: 'fee',
  OPERATION_TYPE_MARGIN_FEE: 'fee',
  OPERATION_TYPE_SUCCESS_FEE: 'fee',
  OPERATION_TYPE_TRACK_MFEE: 'fee',
  OPERATION_TYPE_TRACK_PFEE: 'fee',
  OPERATION_TYPE_OVERNIGHT: 'fee',
};

/** Типы инструментов брокера → типы справочника (schemas.ts, InstrumentSchema) */
const INSTRUMENT_TYPE_MAP: Record<string, string> = {
  share: 'Stock',
  bond: 'Bond',
  etf: 'ETF',
  currency: 'Currency',
};

const BUY_SELL = new Set(['buy', 'sell']);
/** Налоги, которые сворачиваются в свою родительскую выплату (нетто) */
const WITHHOLDING_TAX_TYPES = new Set([
  'OPERATION_TYPE_DIVIDEND_TAX',
  'OPERATION_TYPE_DIVIDEND_TAX_PROGRESSIVE',
  'OPERATION_TYPE_COUPON_TAX',
  'OPERATION_TYPE_BOND_TAX',
]);
/** Выплаты: количество не имеет смысла, вся сумма кладётся в цену (как в XLSX-парсере) */
const PAYOUT_TYPES = new Set(['dividend', 'coupon', 'tax', 'fee', 'deposit', 'withdraw']);

/**
 * MoneyValue/Quotation → десятичная строка. Знак несут ОБА поля (units и nano),
 * поэтому они просто складываются. Через decimal.js, никакого `Number`
 * (CLAUDE.md §11: деньги не через float).
 */
export function moneyToDecimal(value: TbankMoneyValue | undefined): Decimal {
  if (!value) return new Decimal(0);
  const units = new Decimal(value.units ?? '0');
  const nano = new Decimal(value.nano ?? 0).div(1_000_000_000);
  return units.plus(nano);
}

/** Абсолютное значение денежной величины десятичной строкой */
function absMoney(value: TbankMoneyValue | undefined): string {
  return moneyToDecimal(value).abs().toFixed();
}

/** `2024-03-15T10:30:00Z` → `2024-03-15` (normalizeDate ждёт ISO-дату) */
function toIsoDate(raw: string | undefined): string {
  return (raw ?? '').slice(0, 10);
}

/**
 * Раскладывает комиссию операции по её сделкам пропорционально объёму.
 * Остаток от округления отдаётся последней сделке, поэтому сумма комиссий по
 * строкам в точности равна комиссии операции — иначе итоговые затраты по
 * позиции разошлись бы с отчётом брокера на копейки.
 */
function allocateFee(commission: Decimal, weights: Decimal[]): Decimal[] {
  const total = weights.reduce((acc, w) => acc.plus(w), new Decimal(0));
  if (commission.isZero() || total.isZero()) return weights.map(() => new Decimal(0));

  const allocated = weights.map((w) =>
    commission.times(w).div(total).toDecimalPlaces(2, Decimal.ROUND_DOWN),
  );
  const rest = commission.minus(allocated.reduce((acc, a) => acc.plus(a), new Decimal(0)));
  allocated[allocated.length - 1] = allocated[allocated.length - 1].plus(rest);
  return allocated;
}

/**
 * Ответы GetOperationsByCursor → строки импорта.
 *
 * @param items    элементы операций (уже собранные со всех страниц курсора)
 * @param accountId идентификатор счёта у брокера — попадает в `accountRef`,
 *                  по нему `learnAccountMapping` привяжет счёт к портфелю
 * @param instruments справочник `instrumentUid → поля инструмента`: сами операции
 *                  несут только uid/figi, тикер приходится дозапрашивать
 */
export function mapTbankOperations(
  items: TbankOperationItem[],
  accountId: string,
  instruments: Map<string, TbankInstrumentRef> = new Map(),
): RawRow[] {
  const executed = items.filter((i) => i.state === 'OPERATION_STATE_EXECUTED');

  // Удержанный налог брокер присылает отдельной операцией со ссылкой на выплату.
  // Сворачиваем его в родителя (нетто = выплата − налог) — ровно как XLSX-парсер
  // сворачивает пару строк отчёта, иначе одна и та же выплата дала бы разные
  // суммы при импорте из файла и через API.
  const withheldByParent = new Map<string, Decimal>();
  for (const item of executed) {
    if (!item.parentOperationId || !WITHHOLDING_TAX_TYPES.has(item.type ?? '')) continue;
    const prev = withheldByParent.get(item.parentOperationId) ?? new Decimal(0);
    withheldByParent.set(item.parentOperationId, prev.plus(moneyToDecimal(item.payment).abs()));
  }

  // Комиссия брокера отдельной операцией со ссылкой на сделку (BROKER_FEE с
  // parentOperationId) — тот же приём: прибавляем к комиссии родительской Buy/Sell, иначе
  // она висела бы отдельным Fee без инструмента и не попадала в сделку и статистику
  // системы. Сворачиваем здесь, а не через RawRow.parentBrokerRef: у строк-сделок
  // brokerRef — номер биржевой сделки, а parentOperationId указывает на id операции.
  const extraCommissionByParent = new Map<string, Decimal>();
  const foldedFeeIds = new Set<string>();
  for (const item of executed) {
    if (item.type !== 'OPERATION_TYPE_BROKER_FEE' || !item.parentOperationId) continue;
    const parent = executed.find((o) => o.id === item.parentOperationId);
    if (!parent || !BUY_SELL.has(OPERATION_TYPE_MAP[parent.type ?? ''] ?? '')) continue;
    const prev = extraCommissionByParent.get(parent.id ?? '') ?? new Decimal(0);
    extraCommissionByParent.set(parent.id ?? '', prev.plus(moneyToDecimal(item.payment).abs()));
    if (item.id) foldedFeeIds.add(item.id);
  }

  const rows: RawRow[] = [];
  for (const item of executed) {
    if (item.id && foldedFeeIds.has(item.id)) continue;
    // налог, уже учтённый в нетто-сумме родительской выплаты — отдельной строкой не идёт
    if (item.parentOperationId && WITHHOLDING_TAX_TYPES.has(item.type ?? '')) {
      const parentExists = executed.some((o) => o.id === item.parentOperationId);
      if (parentExists) continue;
    }

    const instrument = item.instrumentUid ? instruments.get(item.instrumentUid) : undefined;
    // тикер — основной ключ резолва, ISIN и figi — запасные (resolveInstrument
    // пробует и то, и другое, а `name` служит третьим ключом)
    const ticker = instrument?.ticker || instrument?.isin || item.figi || undefined;
    const currency = (item.payment?.currency ?? instrument?.currency ?? 'rub').toUpperCase();
    const tradeType = OPERATION_TYPE_MAP[item.type ?? ''] ?? item.type ?? '';

    const base = {
      date: toIsoDate(item.date),
      ticker,
      name: instrument?.name,
      instrumentType: INSTRUMENT_TYPE_MAP[instrument?.instrumentType ?? item.instrumentType ?? ''],
      currency,
      tradeType,
      accountRef: accountId,
    } satisfies Partial<RawRow>;

    if (PAYOUT_TYPES.has(tradeType)) {
      const withheld = item.id ? withheldByParent.get(item.id) : undefined;
      const net = moneyToDecimal(item.payment).abs().minus(withheld ?? 0);
      rows.push({
        ...base,
        quantity: '1',
        price: net.toFixed(),
        fee: '0',
        note: withheld ? `${item.description ?? tradeType} нетто (налог учтён)` : item.description,
        // для выплат номер операции у брокера свой в API и в XLSX-отчёте — общего
        // ключа нет, поэтому пересечение периодов с файловым импортом ловится не
        // дедупликацией, а диапазоном дат (по умолчанию — с последней операции в базе)
        brokerRef: item.id,
      });
      continue;
    }

    const trades = item.tradesInfo?.trades ?? [];
    if (!BUY_SELL.has(tradeType) || trades.length === 0) {
      // сделка без списка исполнений (или незнакомый тип) — одна строка на операцию
      const quantity = new Decimal(item.quantity ?? '0').abs();
      rows.push({
        ...base,
        quantity: quantity.toFixed(),
        price: absMoney(item.price),
        fee: moneyToDecimal(item.commission)
          .abs()
          .plus(extraCommissionByParent.get(item.id ?? '') ?? 0)
          .toFixed(),
        note: item.description,
        brokerRef: item.id,
      });
      continue;
    }

    // Одна заявка исполняется несколькими сделками, у каждой свой биржевой номер.
    // Выпускаем строку на КАЖДУЮ сделку с `brokerRef` = номер сделки: именно его
    // пишет XLSX-парсер, поэтому уже импортированная из отчёта сделка распознаётся
    // как дубль, а не заводится второй раз.
    const commission = moneyToDecimal(item.commission)
      .abs()
      .plus(extraCommissionByParent.get(item.id ?? '') ?? 0);
    const weights = trades.map((t) =>
      moneyToDecimal(t.price).abs().times(new Decimal(t.quantity ?? '0').abs()),
    );
    const fees = allocateFee(commission, weights);

    trades.forEach((trade, i) => {
      const num = trade.num || trade.tradeId;
      rows.push({
        ...base,
        date: toIsoDate(trade.date ?? item.date),
        quantity: new Decimal(trade.quantity ?? '0').abs().toFixed(),
        price: absMoney(trade.price),
        fee: fees[i].toFixed(),
        note: num ? `Сделка № ${num}` : item.description,
        brokerRef: num || item.id,
      });
    });
  }

  return rows;
}
