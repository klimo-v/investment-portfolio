import Decimal from 'decimal.js';
import { twrLevels } from './twr';
import type { Operation } from './schemas';
import { marketValueRub, TradeLedger, type TradeResult } from './engine';
import { futureUnrealizedPnl } from './futures-engine';
import { compareOperations } from './operation-order';
import { fxInstrumentId } from './price-history';

/**
 * Дневной ряд оценки — единственный источник всех графиков динамики (стоимость портфеля,
 * стоимость инструментов, кривая «Результат системы»). Чистая функция над ФАКТАМИ: журнал
 * операций + история цен и курсов. Ничего не знает ни о БД, ни о сети, готовых рядов не
 * хранит — правка операции задним числом меняет только дни ≥ её даты просто потому, что
 * ряд каждый раз считается из журнала заново.
 *
 * Одна арифметика с текущими итогами: позиции ведёт тот же TradeLedger, что и calculateTrades
 * (итоги сделок), оценка остатка — тот же marketValueRub (НКД, валюта цены и валюта НКД),
 * фьючерс — futureUnrealizedPnl. Поэтому точка «сегодня» при текущих ценах совпадает с
 * итогом по сделкам, а не «похожа» на него.
 *
 * Определения точки (на день D, по группе):
 *  - fixedRub        — зафиксированное нарастающим итогом: продажи (в т.ч. частичные),
 *                      выплаты на дату выплаты, комиссии фьючерсов (события TradeLedger);
 *  - investedRub     — себестоимость открытого остатка спота («вложено», у фьючерса 0);
 *  - marketValueRub  — рыночная стоимость остатка по цене дня (у фьючерса — нереализованный
 *                      результат, как и в текущей оценке);
 *  - unrealizedRub   — marketValueRub − investedRub (переоценка);
 *  - totalRub        — fixedRub + unrealizedRub.
 *
 * Цена дня D — последняя известная на дату ≤ D (forward-fill). Если цены нет вовсе (или нет
 * курса валюты цены), остаток оценивается по себестоимости (переоценка 0; у фьючерса 0), а
 * инструмент попадает в `carried` с причиной — график честно показывает дыру, а не рисует
 * провал. Перенос цены через будний день без торгов тоже помечается; выходные — нет.
 */

Decimal.set({ precision: 40 });

/** Цена (или курс) на дату, как она хранится в price_history */
export interface PriceObservation {
  /** id инструмента или `fx:USD` (см. fxInstrumentId) */
  instrumentId: string;
  date: string;
  price: string;
  /** валюта ЦЕНЫ (у замещающих облигаций — валюта номинала) */
  currency: string;
  accruedInterest?: string | null;
  /** валюта НКД — своя, не обязана совпадать с валютой цены */
  accruedCurrency?: string | null;
}

export type ValuationGroupBy = 'portfolio' | 'system' | 'instrument';

export interface ValuationOptions {
  /** последний день ряда включительно (обычно сегодня) */
  till: string;
  /** первый день ряда; по умолчанию — дата первой операции. Состояние до `from` считается всё равно */
  from?: string;
  groupBy: ValuationGroupBy;
  systemId?: string;
  portfolioId?: string;
  futureIds?: ReadonlySet<string>;
}

/** Почему оценка инструмента на день не по цене этого дня */
export type CarriedReason =
  | 'no-price' // цены на дату нет вообще — остаток оценён по себестоимости
  | 'no-fx' // нет курса валюты цены — остаток оценён по себестоимости
  | 'carried'; // цена взята за более раннюю дату, а день был будним

export interface CarriedPrice {
  instrumentId: string;
  reason: CarriedReason;
  /** дата цены, которой воспользовались; null — цены не было */
  priceDate: string | null;
}

export interface ValuationPoint {
  date: string;
  investedRub: string;
  marketValueRub: string;
  fixedRub: string;
  unrealizedRub: string;
  totalRub: string;
  carried: CarriedPrice[];
}

export interface ValuationGroup {
  key: string;
  points: ValuationPoint[];
}

export interface ValuationSeries {
  from: string | null;
  till: string;
  groupBy: ValuationGroupBy;
  groups: ValuationGroup[];
  /**
   * Накопленный чистый ввод средств (депозиты − выводы) на каждый день ряда — по тем же
   * датам, что и точки групп. Нужен, чтобы отделить рост стоимости от довнесения капитала.
   */
  netContributionsRub: string[];
}

/** Ключ группы для выплат без инструмента при группировке по инструментам */
export const NO_INSTRUMENT_GROUP = 'no-instrument';

/**
 * Дивиденд/купон без инструмента (в журнале бывают операции «Выплата дивидендов …» без
 * привязки к бумаге): к сделке их не отнести, но деньги получены и в сводке дашборда они
 * есть, поэтому в итог системы они входят отдельным потоком.
 */
export function isUnattributedIncome(op: Operation): boolean {
  return !op.instrumentId && (op.operationType === 'Dividend' || op.operationType === 'Coupon');
}

/** Сумма выплаты в рублях */
export function incomeAmountRub(op: Operation): Decimal {
  return new Decimal(op.quantity).mul(op.price).mul(op.fxRate ?? '1');
}

const ZERO = new Decimal(0);
const DAY_MS = 86_400_000;

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Дней между датами (YYYY-MM-DD) */
function ageDays(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/**
 * Перенос цены дольше этого числа дней считается пропуском данных. Выходные и длинные
 * праздничные выходные (до 3 суток без торгов) — норма и шума не дают: помечаем от 4 суток.
 */
const CARRIED_AFTER_DAYS = 3;

/** Последняя цена ≤ дня по каждому инструменту; дни обходятся по возрастанию, поэтому курсор только растёт */
class PriceCursor {
  private readonly rows = new Map<string, PriceObservation[]>();
  private readonly pos = new Map<string, number>();

  constructor(prices: readonly PriceObservation[]) {
    for (const p of prices) {
      const list = this.rows.get(p.instrumentId);
      if (list) list.push(p);
      else this.rows.set(p.instrumentId, [p]);
    }
    for (const list of this.rows.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  }

  at(instrumentId: string, day: string): PriceObservation | null {
    const list = this.rows.get(instrumentId);
    if (!list) return null;
    let i = this.pos.get(instrumentId) ?? -1;
    while (i + 1 < list.length && list[i + 1].date <= day) i++;
    this.pos.set(instrumentId, i);
    return i >= 0 ? list[i] : null;
  }
}

interface Accumulator {
  invested: Decimal;
  value: Decimal;
  fixed: Decimal;
  carried: CarriedPrice[];
}

export function valuationSeries(
  operations: readonly Operation[],
  prices: readonly PriceObservation[],
  options: ValuationOptions,
): ValuationSeries {
  const keyOf = (r: { instrumentId?: string | null; systemId: string; portfolioId: string }): string =>
    options.groupBy === 'instrument'
      ? (r.instrumentId as string)
      : options.groupBy === 'system'
        ? r.systemId
        : r.portfolioId;

  // Transfer и операции без инструмента (ввод/вывод денег) на позиции не влияют — как в TradeLedger
  const ops = operations
    .filter(
      (o) =>
        o.instrumentId &&
        o.operationType !== 'Transfer' &&
        o.date <= options.till &&
        (!options.systemId || o.systemId === options.systemId) &&
        (!options.portfolioId || o.portfolioId === options.portfolioId),
    )
    .sort(compareOperations);

  const incomeOps = operations
    .filter(
      (o) =>
        isUnattributedIncome(o) &&
        o.date <= options.till &&
        (!options.systemId || o.systemId === options.systemId) &&
        (!options.portfolioId || o.portfolioId === options.portfolioId),
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  const incomeKeyOf = (o: Operation): string => (options.groupBy === 'instrument' ? NO_INSTRUMENT_GROUP : keyOf(o));

  const keys = [...new Set([...ops.map(keyOf), ...incomeOps.map(incomeKeyOf)])].sort();
  if (ops.length === 0) {
    return { from: options.from ?? null, till: options.till, groupBy: options.groupBy, groups: [], netContributionsRub: [] };
  }

  // ввод/вывод денег — операции без инструмента; тот же фильтр системы/портфеля
  const cashOps = operations
    .filter(
      (o) =>
        (o.operationType === 'Deposit' || o.operationType === 'Withdraw') &&
        o.date <= options.till &&
        (!options.systemId || o.systemId === options.systemId) &&
        (!options.portfolioId || o.portfolioId === options.portfolioId),
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  let nextCash = 0;
  let netContributions = ZERO;
  const netContributionsRub: string[] = [];

  const fixedByKey = new Map<string, Decimal>(keys.map((k) => [k, ZERO]));
  const ledger = new TradeLedger({ futureIds: options.futureIds }, (trade, event) => {
    const k = keyOf(trade);
    fixedByKey.set(k, (fixedByKey.get(k) ?? ZERO).plus(event.rub));
  });

  const cursor = new PriceCursor(prices);
  const firstDay = incomeOps.length > 0 && incomeOps[0].date < ops[0].date ? incomeOps[0].date : ops[0].date;
  const outFrom = options.from && options.from > firstDay ? options.from : firstDay;
  const points = new Map<string, ValuationPoint[]>(keys.map((k) => [k, []]));

  let next = 0;
  let nextIncome = 0;
  for (let day = firstDay; day <= options.till; day = addDays(day, 1)) {
    while (next < ops.length && ops[next].date <= day) ledger.apply(ops[next++]);
    while (nextIncome < incomeOps.length && incomeOps[nextIncome].date <= day) {
      const o = incomeOps[nextIncome++];
      const k = incomeKeyOf(o);
      fixedByKey.set(k, (fixedByKey.get(k) ?? ZERO).plus(incomeAmountRub(o)));
    }
    while (nextCash < cashOps.length && cashOps[nextCash].date <= day) {
      const o = cashOps[nextCash++];
      const amount = new Decimal(o.quantity).mul(o.price).mul(o.fxRate ?? '1');
      netContributions = o.operationType === 'Deposit' ? netContributions.plus(amount) : netContributions.minus(amount);
    }
    if (day < outFrom) continue;
    netContributionsRub.push(netContributions.toFixed(2));

    const acc = new Map<string, Accumulator>(
      keys.map((k) => [k, { invested: ZERO, value: ZERO, fixed: fixedByKey.get(k) ?? ZERO, carried: [] }]),
    );
    for (const trade of ledger.openTrades()) {
      if (trade.quantity.isZero()) continue;
      const a = acc.get(keyOf(trade));
      if (!a) continue;
      valueOpenTrade(trade, day, cursor, options.futureIds, a);
    }

    for (const k of keys) {
      const a = acc.get(k) as Accumulator;
      const unrealized = a.value.minus(a.invested);
      (points.get(k) as ValuationPoint[]).push({
        date: day,
        investedRub: a.invested.toFixed(2),
        marketValueRub: a.value.toFixed(2),
        fixedRub: a.fixed.toFixed(2),
        unrealizedRub: unrealized.toFixed(2),
        totalRub: a.fixed.plus(unrealized).toFixed(2),
        carried: a.carried,
      });
    }
  }

  return {
    from: outFrom,
    till: options.till,
    groupBy: options.groupBy,
    groups: keys.map((key) => ({ key, points: points.get(key) as ValuationPoint[] })),
    netContributionsRub,
  };
}

/** Оценка одной открытой сделки на день: добавляет вложено/стоимость и пометки в аккумулятор группы */
function valueOpenTrade(
  trade: TradeResult,
  day: string,
  cursor: PriceCursor,
  futureIds: ReadonlySet<string> | undefined,
  acc: Accumulator,
): void {
  const isFuture = futureIds?.has(trade.instrumentId) ?? false;
  const obs = cursor.at(trade.instrumentId, day);

  const note = (reason: CarriedReason): void => {
    acc.carried.push({ instrumentId: trade.instrumentId, reason, priceDate: obs?.date ?? null });
  };
  // стоимость без цены: спот — по себестоимости (переоценка 0), фьючерс — 0 (нет расчётной цены)
  const fallback = (reason: CarriedReason): void => {
    if (!isFuture) {
      acc.invested = acc.invested.plus(trade.investedRub);
      acc.value = acc.value.plus(trade.investedRub);
    }
    note(reason);
  };

  if (!obs) return fallback('no-price');

  if (isFuture) {
    // у фьючерса «стоимость» — нереализованный результат, вложено 0 (цена — ₽ за контракт)
    acc.value = acc.value.plus(
      futureUnrealizedPnl({ quantity: trade.quantity, avgBuyPrice: trade.avgBuyPrice }, obs.price).toDecimalPlaces(2),
    );
  } else {
    if (!trade.quantity.gt(0)) return; // спот с нулём/минусом — некорректные данные, как в текущей оценке
    const fx = fxRateAt(obs.currency, day, cursor);
    const accruedFx =
      obs.accruedInterest === null || obs.accruedInterest === undefined
        ? fx
        : fxRateAt(obs.accruedCurrency || obs.currency, day, cursor);
    if (fx === null || accruedFx === null) return fallback('no-fx');
    acc.invested = acc.invested.plus(trade.investedRub);
    // стоимость позиции округляется до копеек на уровне сделки — как в текущей оценке
    // (OperationsService.valuedTrades), иначе итоги расходились бы на копейки по числу позиций
    acc.value = acc.value.plus(
      marketValueRub({
        quantity: trade.quantity,
        price: obs.price,
        fxRate: fx,
        accruedInterest: obs.accruedInterest ?? null,
        accruedFxRate: accruedFx,
      }).toDecimalPlaces(2),
    );
  }
  if (ageDays(obs.date, day) > CARRIED_AFTER_DAYS) note('carried');
}

/** Курс валюты к рублю на день (forward-fill); RUB — 1; null — курса нет */
function fxRateAt(currency: string, day: string, cursor: PriceCursor): Decimal | null {
  const c = currency.toUpperCase();
  if (c === 'RUB') return new Decimal(1);
  const obs = cursor.at(fxInstrumentId(c), day);
  return obs ? new Decimal(obs.price) : null;
}

/**
 * Индекс доходности портфеля с очисткой от потоков (time-weighted return), база 100.
 *
 * Стоимость позиций для графика динамики не годится: продажа переводит деньги в кэш и роняет
 * «стоимость» без всякого убытка, довнесение двигает её вверх без прибыли. Поэтому берём
 * богатство W = чистый ввод + итог (зафиксированное + переоценка): это «позиции + кэш», в
 * котором продажа ничего не меняет. Остаётся отделить ввод/вывод денег: дневная доходность
 * r = (W_t − W_{t−1} − поток_t) / W_{t−1}, индекс — цепочка (1 + r). Дни до первого W > 0
 * стоят на базе 100; если богатство ушло в ≤ 0, доходность дня считаем нулевой (делить не на что).
 *
 * Поток = изменение чистого ввода; предполагается, что ввод/вывод денег внесён в журнал
 * (Deposit/Withdraw) — иначе довнесение будет выглядеть как прибыль.
 */
export function timeWeightedIndex(
  points: readonly { totalRub: number; netContributionsRub: number }[],
): number[] {
  // богатство W = чистый ввод + итог; поток дня — изменение чистого ввода (первая точка — старт)
  const inputs = points.map((p, i) => ({
    value: new Decimal(p.netContributionsRub).plus(p.totalRub),
    flow: new Decimal(p.netContributionsRub).minus(i > 0 ? points[i - 1].netContributionsRub : 0),
  }));
  return twrLevels(inputs, null).levels.map((l) => l.toNumber());
}

/**
 * Дневной ряд «за период»: накопленные значения сдвигаются так, чтобы на день ДО `from`
 * они были нулём (результат за период, а не с начала истории). Зафиксированное и переоценка
 * сдвигаются каждое на свою базу, поэтому totalRub = fixedRub + unrealizedRub остаётся верным.
 * Точки до `from` отбрасываются; вложено/стоимость — состояние на день, их не трогаем.
 * Нет точки до `from` (период начинается с первой операции) — сдвиг нулевой.
 */
export function rebaseToPeriod(points: readonly ValuationPoint[], from: string): ValuationPoint[] {
  const firstIdx = points.findIndex((p) => p.date >= from);
  if (firstIdx < 0) return [];
  const base = firstIdx > 0 ? points[firstIdx - 1] : null;
  const baseFixed = new Decimal(base?.fixedRub ?? 0);
  const baseUnrealized = new Decimal(base?.unrealizedRub ?? 0);
  return points.slice(firstIdx).map((p) => {
    const fixed = new Decimal(p.fixedRub).minus(baseFixed);
    const unrealized = new Decimal(p.unrealizedRub).minus(baseUnrealized);
    return {
      ...p,
      fixedRub: fixed.toFixed(2),
      unrealizedRub: unrealized.toFixed(2),
      totalRub: fixed.plus(unrealized).toFixed(2),
    };
  });
}
