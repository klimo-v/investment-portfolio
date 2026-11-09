import Decimal from 'decimal.js';
import { maxDrawdown, xirr, type CashFlow } from './metrics';
import type { Operation } from './schemas';
import { twrLevels } from './twr';
import { incomeAmountRub, type ValuationSeries } from './valuation';

/**
 * Единый расчёт доходности за период (docs/tasks/unified-performance-prompt.md, §2.1).
 *
 * Всё считается из ОДНОГО дневного ряда `valuationSeries` и пары (V, F) на каждый день:
 *  - V_t — капитал контура;
 *  - F_t — внешний поток контура (+ деньги внутрь).
 *
 * Контур определяет, что считать капиталом:
 *  - `wealth` (весь портфель/счёт, у него есть свой кэш): V = чистый ввод + итог = позиции + кэш;
 *  - `positions` (система/инструмент, своего кэша нет): V = рыночная стоимость позиций группы.
 *
 * Поток выводится из ряда тождеством, одинаковым для всех контуров. Накопленный итог
 * P_t = зафиксированное + переоценка (totalRub), и по определению результата
 * ΔV = ΔP + F, откуда F_t = (V_t − P_t) − (V_{t−1} − P_{t−1}):
 *  - портфель: V − P = чистый ввод → F = Deposit − Withdraw;
 *  - группа:   V − P = себестоимость − зафиксированное → F = покупки − выручка продаж − выплаты.
 *
 * Из пары рядов получаются результат ₽, TWR (индекс — тот же массив, что итог карточки),
 * XIRR и средний капитал (Modified Dietz) — одними формулами для любого контура.
 *
 * ВАЖНО: ряд должен начинаться не позже дня ДО `from` (лучше — с первой операции:
 * `valuationSeries` без `from`). Если точки до `from` нет, база периода считается нулевой
 * (период начинается с первой операции).
 */

Decimal.set({ precision: 40 });

const ZERO = new Decimal(0);
const DAY_MS = 86_400_000;

/** Период короче этого числа дней показываем доходностью за период, не годовой (аннуализация шумит) */
export const ANNUALIZE_FROM_DAYS = 365;

/**
 * Допуск отрицательного капитала — доля пикового капитала периода. Копейки в минус на почти пустом счёте
 * (комиссии и налоги после полного вывода: −402 ₽ при капитале 3,9 млн ₽) проценты не обесценивают; существенный
 * минус (покупки без внесённых денег) — да.
 */
export const NEGATIVE_CAPITAL_TOLERANCE = 0.001;

export type PerformanceContour = 'wealth' | 'positions';

/** Почему метрику нельзя посчитать */
export type PerformanceUnavailable =
  | 'no-capital' // за период не было капитала: делить не на что (например, система только из фьючерсов)
  | 'negative-capital' // капитал контура уходил в минус: журнал неполон (нет Deposit/перевода), проценты недостоверны
  | 'no-data' // в ряду нет дней периода
  | 'xirr-undefined'; // у потоков нет решения, либо они слишком близки/нет притока и оттока

/** День контура: капитал, накопленный итог и его части (всё нарастающим итогом) */
export interface ContourDay {
  date: string;
  value: Decimal;
  result: Decimal;
  fixed: Decimal;
  unrealized: Decimal;
  /** себестоимость открытого остатка спота; у фьючерсов 0 */
  invested: Decimal;
  /** валовый приток капитала дня (ввод денег / покупки) — база TWR; null — ряд без валовых потоков */
  inflow: Decimal | null;
  /** накопленные отдельные налоги/комиссии контура — расходы счёта, а не результат вложенного капитала */
  costs: Decimal;
}

export interface PeriodPerformanceOptions {
  /** первый день периода включительно; не задан — с первой точки ряда («Всё время») */
  from?: string;
  contour: PerformanceContour;
  /** для `positions`: ключ группы ряда (система/инструмент); не задан — сумма всех групп */
  groupKey?: string;
  /** выплаты (дивиденды + купоны) за период — для разбивки зафиксированного; см. payoutsInPeriod */
  payoutsRub?: Decimal;
}

export interface TwrPoint {
  date: string;
  /** уровень индекса, база 100 на день ДО периода */
  index: number;
}

export interface PeriodPerformance {
  contour: PerformanceContour;
  from: string | null;
  till: string | null;
  /** день базы (V_start) — последний день до периода; null — период с первой операции (база 0) */
  baseDate: string | null;
  /** длина периода в днях: от базы (или дня перед первой точкой) до конца */
  days: number;
  startValueRub: string;
  endValueRub: string;
  /** ΣF — чистый внешний поток периода */
  netFlowRub: string;
  /** V_end − V_start − ΣF  (= Δ зафиксированного + Δ переоценки) */
  resultRub: string;
  breakdown: {
    /** Δ зафиксированного: продажи + выплаты (+ комиссии/расчёты фьючерсов) */
    fixedRub: string;
    /** выплаты периода, если переданы payoutsRub */
    payoutsRub: string | null;
    /** зафиксированное без выплат (fixed − payouts), если переданы payoutsRub */
    realizedRub: string | null;
    /** Δ переоценки остатка */
    revaluationRub: string;
  };
  twr: {
    /** TWR за период, %; null — не было капитала */
    pct: number | null;
    /** ряд индекса с точкой базы (100) первой: последняя точка ≡ pct + 100 (один и тот же расчёт) */
    series: TwrPoint[];
    reason: PerformanceUnavailable | null;
  };
  /** доходность ваших денег: годовая (период ≥ 365 дн.) или за период — см. kind */
  mwr: {
    kind: 'annual' | 'period';
    pct: number | null;
    reason: PerformanceUnavailable | null;
  };
  /** XIRR в годовых по рыночной базе на начало периода; null — не определён */
  xirrPct: number | null;
  /** результат / средний капитал (Modified Dietz), % за период */
  dietzPct: number | null;
  /** максимальная просадка ряда TWR, % (≤ 0); null — меньше двух точек или процентов нет */
  maxDrawdownPct: number | null;
  /** V_start + Σ w·F, w — доля периода, в течение которой поток работал */
  averageCapitalRub: string;
  /**
   * Подсказка: с какой даты капитал контура стал значимым (см. suggestTwrStart). Не null, только если
   * до неё в периоде был ничтожный капитал: TWR честно считает и его (доходность 2 ₽ на курсе юаня),
   * но к деньгам счёта это отношения не имеет. Цифры от подсказки не зависят — решает пользователь.
   */
  twrSuggestedFrom: string | null;
}

/** Доля пика капитала, ниже которой капитал считается ничтожным ТОЛЬКО для подсказки начала периода */
export const MATERIAL_CAPITAL_SHARE = 0.001;

/**
 * Подсказка начала TWR: первый день последнего непрерывного отрезка, на котором капитал не ниже доли
 * MATERIAL_CAPITAL_SHARE от пика периода. Не меняет расчёт — только предлагает «Считать с этой даты».
 * null — весь период значим (подсказывать нечего).
 */
export function suggestTwrStart(days: readonly { date: string; value: Decimal }[]): string | null {
  if (days.length === 0) return null;
  const peak = days.reduce((m, d) => (d.value.gt(m) ? d.value : m), ZERO);
  if (!peak.gt(0)) return null;
  const floor = peak.mul(MATERIAL_CAPITAL_SHARE);
  let start = days.length;
  for (let i = days.length - 1; i >= 0 && days[i].value.gte(floor); i--) start = i;
  return start > 0 && start < days.length ? days[start].date : null;
}

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
}

/** Дни контура из ряда valuationSeries (деньги — Decimal из строк ряда) */
export function contourDays(
  series: ValuationSeries,
  contour: PerformanceContour,
  groupKey?: string,
): ContourDay[] {
  const groups = groupKey === undefined ? series.groups : series.groups.filter((g) => g.key === groupKey);
  const first = series.groups[0];
  if (!first) return [];
  return first.points.map((point, i) => {
    let market = ZERO;
    let fixed = ZERO;
    let unrealized = ZERO;
    let invested = ZERO;
    let costs = ZERO;
    let purchases: Decimal | null = ZERO;
    for (const g of groups) {
      const p = g.points[i];
      market = market.plus(p.marketValueRub);
      fixed = fixed.plus(p.fixedRub);
      unrealized = unrealized.plus(p.unrealizedRub);
      invested = invested.plus(p.investedRub);
      costs = costs.plus(p.standaloneCostsRub ?? 0);
      purchases = p.purchasesRub === undefined || purchases === null ? null : purchases.plus(p.purchasesRub);
    }
    const grossIn = series.contributionInflowsRub?.[i];
    const inflow = contour === 'wealth' ? (grossIn === undefined ? null : new Decimal(grossIn)) : purchases;
    const result = fixed.plus(unrealized);
    const value = contour === 'wealth' ? new Decimal(series.netContributionsRub[i] ?? 0).plus(result) : market;
    return { date: point.date, value, result, fixed, unrealized, invested, inflow, costs };
  });
}

/**
 * Выплаты (Dividend + Coupon) за период [from, till] в рублях с тем же фильтром, что у ряда.
 * Для разбивки «реализованное / выплаты / переоценка».
 */
export function payoutsInPeriod(
  operations: readonly Operation[],
  range: { from?: string; till: string; systemId?: string; portfolioId?: string; instrumentId?: string },
): Decimal {
  let sum = ZERO;
  for (const o of operations) {
    if (o.operationType !== 'Dividend' && o.operationType !== 'Coupon') continue;
    if (range.from && o.date < range.from) continue;
    if (o.date > range.till) continue;
    if (range.systemId && o.systemId !== range.systemId) continue;
    if (range.portfolioId && o.portfolioId !== range.portfolioId) continue;
    if (range.instrumentId && o.instrumentId !== range.instrumentId) continue;
    sum = sum.plus(incomeAmountRub(o));
  }
  return sum;
}

const money = (d: Decimal): string => d.toFixed(2);

/** Единый расчёт периода по ряду valuationSeries и контуру */
export function periodPerformance(series: ValuationSeries, options: PeriodPerformanceOptions): PeriodPerformance {
  const days = contourDays(series, options.contour, options.groupKey);
  const from = options.from;
  const idxFrom = from === undefined ? 0 : days.findIndex((d) => d.date >= from);
  const empty = (reason: PerformanceUnavailable): PeriodPerformance => ({
    contour: options.contour,
    from: options.from ?? null,
    till: days.length > 0 ? days[days.length - 1].date : null,
    baseDate: null,
    days: 0,
    startValueRub: money(ZERO),
    endValueRub: money(ZERO),
    netFlowRub: money(ZERO),
    resultRub: money(ZERO),
    breakdown: { fixedRub: money(ZERO), payoutsRub: null, realizedRub: null, revaluationRub: money(ZERO) },
    twr: { pct: null, series: [], reason },
    mwr: { kind: 'period', pct: null, reason },
    xirrPct: null,
    dietzPct: null,
    maxDrawdownPct: null,
    averageCapitalRub: money(ZERO),
    twrSuggestedFrom: null,
  });
  if (days.length === 0 || idxFrom < 0) return empty('no-data');

  const period = days.slice(idxFrom);
  const realBase = idxFrom > 0 ? days[idxFrom - 1] : null;
  const baseDate = realBase?.date ?? addDays(period[0].date, -1);
  const start = realBase ?? { date: baseDate, value: ZERO, result: ZERO, fixed: ZERO, unrealized: ZERO, invested: ZERO, inflow: null, costs: ZERO };
  const end = period[period.length - 1];

  // внешний поток дня: F_t = (V_t − P_t) − (V_{t−1} − P_{t−1})
  let prevGap = start.value.minus(start.result);
  let prevCosts = start.costs;
  const inputs = period.map((d) => {
    const gap = d.value.minus(d.result);
    const flow = gap.minus(prevGap);
    prevGap = gap;
    const costsToday = d.costs.minus(prevCosts);
    prevCosts = d.costs;
    return { date: d.date, value: d.value, flow, inflow: d.inflow, costsToday };
  });
  const netFlow = inputs.reduce((s, d) => s.plus(d.flow), ZERO);
  const result = end.value.minus(start.value).minus(netFlow);

  // TWR: ряд индекса и итог — один массив
  // для TWR: отдельные налоги/комиссии контура позиций — расход счёта, а не приток вложенного капитала
  // (иначе комиссия 1 198 ₽ на остатке 2 ₽ «вносила» капитал и тут же теряла его: −99,8%);
  // у контура богатства они остаются результатом, как и в ₽-итоге
  const twrInputs = inputs.map((d) => ({
    value: d.value,
    flow: options.contour === 'positions' ? d.flow.minus(d.costsToday) : d.flow,
    inflow: d.inflow ?? undefined,
  }));
  const twr = twrLevels(twrInputs, start.value);
  const seriesPoints: TwrPoint[] = [];
  // база 100 — день ДО периода (у периода с первой операции это условный день перед первой точкой):
  // тогда доходность первого дня входит в ряд, а ориентир нормируется на ту же дату
  seriesPoints.push({ date: baseDate, index: 100 });
  period.forEach((d, i) => seriesPoints.push({ date: d.date, index: twr.levels[i].toNumber() }));
  const lastLevel = twr.levels[twr.levels.length - 1];
  // контур позиций без вложенного капитала (система только из фьючерсов: V — это переоценка, не деньги)
  // процентов не имеет: результат в ₽ есть, а делить на капитал нечего
  const hasCapital =
    options.contour === 'wealth' || start.invested.gt(0) || period.some((d) => d.invested.gt(0));
  // Капитал контура был отрицательным (покупки без внесённых денег): TWR пропускает такие дни, а Dietz и XIRR
  // считают их по-своему — цифры расходились втрое без оговорки. Проценты тогда не показываем: результат в ₽
  // верен, а причину («журнал неполон») пользователь видит в предупреждении о кэше.
  const peak = inputs.reduce((m, d) => (d.value.gt(m) ? d.value : m), start.value);
  const floor = peak.mul(NEGATIVE_CAPITAL_TOLERANCE).neg();
  let prevValue = start.value;
  let negativeDays = 0;
  for (const d of inputs) {
    if (prevValue.lt(floor)) negativeDays++;
    prevValue = d.value;
  }
  const reliable = negativeDays === 0;
  const twrPct = reliable && hasCapital && twr.capitalDays > 0 ? lastLevel.minus(100).toNumber() : null;
  // у контура без капитала (система из одних фьючерсов) «стоимость» бывает отрицательной — это не неполный журнал
  const unavailable: PerformanceUnavailable = !hasCapital || reliable ? 'no-capital' : 'negative-capital';

  // Modified Dietz: ввод работает с начала дня (вес включает день потока), вывод — с конца
  const total = daysBetween(baseDate, end.date);
  let averageCapital = start.value;
  for (const d of inputs) {
    if (d.flow.isZero()) continue;
    const remaining = daysBetween(baseDate, end.date) - daysBetween(baseDate, d.date) + (d.flow.gt(0) ? 1 : 0);
    averageCapital = averageCapital.plus(d.flow.mul(remaining).div(total));
  }
  const dietz = reliable && hasCapital && averageCapital.gt(0) ? result.div(averageCapital).mul(100).toNumber() : null;

  // XIRR: отток V_start (по рынку) на день базы, внешние потоки на их даты, приток V_end на конец
  const flows: CashFlow[] = [];
  if (start.value.gt(0)) flows.push({ date: baseDate, amount: -start.value.toNumber() });
  for (const d of inputs) if (!d.flow.isZero()) flows.push({ date: d.date, amount: -d.flow.toNumber() });
  flows.push({ date: end.date, amount: end.value.toNumber() });
  const rate = reliable && hasCapital ? xirr(flows) : null;
  const xirrPct = rate === null ? null : rate * 100;

  const annual = total >= ANNUALIZE_FROM_DAYS;
  const mwrPct = annual ? xirrPct : dietz;
  const mwrReason: PerformanceUnavailable | null =
    mwrPct !== null ? null : reliable && annual && hasCapital && averageCapital.gt(0) ? 'xirr-undefined' : unavailable;

  const payouts = options.payoutsRub ?? null;
  const fixedDelta = end.fixed.minus(start.fixed);
  return {
    contour: options.contour,
    from: options.from ?? null,
    till: end.date,
    baseDate: realBase?.date ?? null,
    days: total,
    startValueRub: money(start.value),
    endValueRub: money(end.value),
    netFlowRub: money(netFlow),
    resultRub: money(result),
    breakdown: {
      fixedRub: money(fixedDelta),
      payoutsRub: payouts ? money(payouts) : null,
      realizedRub: payouts ? money(fixedDelta.minus(payouts)) : null,
      revaluationRub: money(end.unrealized.minus(start.unrealized)),
    },
    twr: { pct: twrPct, series: hasCapital && reliable ? seriesPoints : [], reason: twrPct === null ? unavailable : null },
    mwr: { kind: annual ? 'annual' : 'period', pct: mwrPct, reason: mwrReason },
    xirrPct,
    dietzPct: dietz,
    maxDrawdownPct: hasCapital && reliable && seriesPoints.length >= 2 ? maxDrawdown(seriesPoints.map((p) => p.index)) * 100 : null,
    averageCapitalRub: money(averageCapital),
    twrSuggestedFrom: reliable && hasCapital ? suggestTwrStart(period) : null,
  };
}
