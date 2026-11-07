import Decimal from 'decimal.js';
import type { ExecutionStats, SystemPerformance } from './schemas';
import { slippageRub } from './annotations';
import type { TradeResult } from './engine';

/**
 * Статистика результатов торговой системы — чистая функция над сделками движка
 * (TradeResult, engine.ts). Ничего не знает ни о БД, ни о типах инструментов: фьючерсы
 * и акции различаются уже внутри движка, сюда приходит результат сделки в рублях.
 *
 * Деньги считаем на decimal.js; безразмерные коэффициенты (win rate, profit factor,
 * Sharpe) — number. Определения всех метрик — docs/02-data-model.md.
 */

Decimal.set({ precision: 40 });

const ZERO = new Decimal(0);
const MS_DAY = 86_400_000;

/** Результат без полей, которые добавляет вызывающий (справочник систем) */
export type SystemPerformanceBody = Omit<
  SystemPerformance,
  'systemId' | 'systemName' | 'reconciliation'
>;

/** Исполнение операции с аннотацией: тег и сигнальная цена (annotations.ts) */
export interface ExecutionFill {
  operationId: string;
  tag: string | null;
  side: 'Buy' | 'Sell';
  quantity: Decimal;
  price: Decimal;
  /** ₽ за контракт; null — сигнальной цены нет, проскальзывание не считается */
  signalPrice: Decimal | null;
}

export interface PerformanceOptions {
  /** аннотации исполнения; без них (или без пересечения со сделками) блока «Исполнение» нет */
  fills?: readonly ExecutionFill[];
  /**
   * Нереализованный результат открытой сделки в ₽ (по расчётной цене); null/не задан —
   * оценки нет. Считает вызывающий: у него котировки, у чистой функции их нет.
   */
  unrealizedOf?: (trade: TradeResult) => Decimal | null;
}

// ───────────────────────── общие классификация и счётчики ─────────────────────────

/** Исходы сделок: одна реализация win/loss для всех потребителей (DRY) */
export interface OutcomeStats {
  count: number;
  wins: number;
  losses: number;
  breakeven: number;
  /** сумма прибылей (≥ 0) */
  grossProfit: Decimal;
  /** сумма убытков по модулю (≥ 0) */
  grossLoss: Decimal;
  /** доля прибыльных, %; null — сделок нет */
  winRatePct: number | null;
  /** сумма прибылей / сумма убытков; null — убытков не было */
  profitFactor: number | null;
}

export function outcomeStats(results: readonly Decimal[]): OutcomeStats {
  let wins = 0;
  let losses = 0;
  let grossProfit = ZERO;
  let grossLoss = ZERO;
  for (const r of results) {
    if (r.gt(0)) {
      wins++;
      grossProfit = grossProfit.plus(r);
    } else if (r.lt(0)) {
      losses++;
      grossLoss = grossLoss.minus(r);
    }
  }
  const count = results.length;
  return {
    count,
    wins,
    losses,
    breakeven: count - wins - losses,
    grossProfit,
    grossLoss,
    winRatePct: count > 0 ? (wins / count) * 100 : null,
    profitFactor: grossLoss.gt(0) ? grossProfit.div(grossLoss).toNumber() : null,
  };
}

// ───────────────────────────────── просадка по P&L ─────────────────────────────────

export interface AbsoluteDrawdown {
  /** наибольшее падение от пика до дна, ₽, ≥ 0 */
  maxDrawdown: Decimal;
  peakIndex: number | null;
  troughIndex: number | null;
  /** первый индекс после дна, где ряд вернулся к пику; null — не восстановилась */
  recoveryIndex: number | null;
  /** просадка в каждой точке: значение − текущий пик (≤ 0) */
  series: Decimal[];
}

/**
 * Абсолютная просадка по ряду накопленного P&L, стартующему с нуля. Отдельная функция,
 * а не metrics.maxDrawdown: та работает с рядом СТОИМОСТИ (пик > 0, относительная
 * просадка в долях), а у P&L ноль — законная точка, и процент от нуля не определён.
 */
export function absoluteDrawdown(equity: readonly Decimal[]): AbsoluteDrawdown {
  let peak = equity[0] ?? ZERO;
  let peakIdx = 0;
  let best = ZERO;
  let bestPeakIdx: number | null = null;
  let bestTroughIdx: number | null = null;
  const series: Decimal[] = [];

  equity.forEach((value, i) => {
    if (value.gt(peak)) {
      peak = value;
      peakIdx = i;
    }
    const dd = peak.minus(value);
    series.push(value.minus(peak));
    if (dd.gt(best)) {
      best = dd;
      bestPeakIdx = peakIdx;
      bestTroughIdx = i;
    }
  });

  let recoveryIndex: number | null = null;
  if (bestPeakIdx !== null && bestTroughIdx !== null) {
    const peakValue = equity[bestPeakIdx];
    for (let i = bestTroughIdx + 1; i < equity.length; i++) {
      if (equity[i].gte(peakValue)) {
        recoveryIndex = i;
        break;
      }
    }
  }
  return {
    maxDrawdown: best,
    peakIndex: bestPeakIdx,
    troughIndex: bestTroughIdx,
    recoveryIndex,
    series,
  };
}

// ─────────────────────────────────── даты и время ───────────────────────────────────

function dayMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function dateTimeMs(date: string, time: string | null): number {
  return Date.parse(`${date}T${time ?? '00:00:00'}Z`);
}

function daysBetween(a: string, b: string): number {
  return Math.round((dayMs(b) - dayMs(a)) / MS_DAY);
}

function addDays(date: string, n: number): string {
  return new Date(dayMs(date) + n * MS_DAY).toISOString().slice(0, 10);
}

/** 1 = понедельник … 7 = воскресенье */
function isoWeekday(date: string): number {
  const d = new Date(dayMs(date)).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Срок удержания закрытой сделки в часах: по времени, если оно есть у обоих концов, иначе по датам */
function holdingHours(t: TradeResult): { hours: number; timed: boolean } {
  const closedAt = t.closedAt as string;
  const timed = t.openedTime !== null && t.closedTime !== null;
  const ms = timed
    ? dateTimeMs(closedAt, t.closedTime) - dateTimeMs(t.openedAt, t.openedTime)
    : dayMs(closedAt) - dayMs(t.openedAt);
  return { hours: Math.max(0, ms) / 3_600_000, timed };
}

// ─────────────────────────────────── основная функция ───────────────────────────────

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;

const money = (d: Decimal): string => d.toFixed(2);

/** Порядок закрытия: дата → время → дата открытия (стабильно при равных ключах) */
function byCloseOrder(a: TradeResult, b: TradeResult): number {
  return (
    (a.closedAt as string).localeCompare(b.closedAt as string) ||
    (a.closedTime ?? '').localeCompare(b.closedTime ?? '') ||
    a.openedAt.localeCompare(b.openedAt)
  );
}

/** Число интервалов гистограммы по Стёрджессу, не больше 12 */
function histogramBins(n: number): number {
  return Math.min(12, Math.max(1, Math.ceil(Math.log2(n) + 1)));
}

function buildHistogram(values: Decimal[]): SystemPerformanceBody['series']['histogram'] {
  if (values.length === 0) return [];
  const min = Decimal.min(...values);
  const max = Decimal.max(...values);
  if (min.eq(max)) {
    return [{ fromRub: money(min), toRub: money(max), count: values.length }];
  }
  const bins = histogramBins(values.length);
  const width = max.minus(min).div(bins);
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const idx = Math.min(bins - 1, v.minus(min).div(width).floor().toNumber());
    counts[idx]++;
  }
  return counts.map((count, i) => ({
    fromRub: money(min.plus(width.mul(i))),
    toRub: money(min.plus(width.mul(i + 1))),
    count,
  }));
}

/** Блок «Исполнение»: проскальзывание от сигнальной цены и результат по тегу входа */
function executionStats(
  trades: readonly TradeResult[],
  closed: readonly TradeResult[],
  allFills: readonly ExecutionFill[] | undefined,
): ExecutionStats | null {
  if (!allFills || allFills.length === 0) return null;
  const mine = new Set(trades.flatMap((t) => t.operationIds));
  const fills = allFills.filter((f) => mine.has(f.operationId));
  if (fills.length === 0) return null;

  const tagKey = (tag: string | null): string => tag ?? '';
  const byTag = new Map<string, { tag: string | null; fills: number; contracts: Decimal; slip: Decimal }>();
  let total = ZERO;
  let contracts = ZERO;
  for (const f of fills) {
    const g = byTag.get(tagKey(f.tag)) ?? { tag: f.tag, fills: 0, contracts: ZERO, slip: ZERO };
    g.fills++;
    if (f.signalPrice) {
      const slip = slippageRub(f.side, f.price, f.signalPrice, f.quantity);
      g.slip = g.slip.plus(slip);
      g.contracts = g.contracts.plus(f.quantity);
      total = total.plus(slip);
      contracts = contracts.plus(f.quantity);
    }
    byTag.set(tagKey(f.tag), g);
  }

  // тег входа сделки — тег первого аннотированного исполнения (operationIds идут в порядке сделок)
  const tagOfOp = new Map(fills.map((f) => [f.operationId, f.tag]));
  const entry = new Map<string, { tag: string | null; pnls: Decimal[] }>();
  for (const t of closed) {
    const firstTagged = t.operationIds.find((id) => tagOfOp.get(id));
    const tag = firstTagged ? (tagOfOp.get(firstTagged) as string) : null;
    const g = entry.get(tagKey(tag)) ?? { tag, pnls: [] };
    g.pnls.push(t.realizedPnlRub);
    entry.set(tagKey(tag), g);
  }

  return {
    fills: fills.length,
    contractsWithSignal: contracts.toString(),
    totalSlippageRub: money(total),
    avgSlippagePerContractRub: contracts.gt(0) ? money(total.div(contracts)) : null,
    byTag: [...byTag.values()]
      .sort((a, b) => tagKey(a.tag).localeCompare(tagKey(b.tag)))
      .map((g) => ({ tag: g.tag, fills: g.fills, contracts: g.contracts.toString(), slippageRub: money(g.slip) })),
    byEntryTag: [...entry.values()]
      .sort((a, b) => tagKey(a.tag).localeCompare(tagKey(b.tag)))
      .map((g) => {
        const o = outcomeStats(g.pnls);
        return {
          tag: g.tag,
          trades: o.count,
          wins: o.wins,
          winRatePct: o.winRatePct,
          netPnlRub: money(g.pnls.reduce((s, x) => s.plus(x), ZERO)),
        };
      }),
  };
}

export const RATIO_ASSUMPTIONS =
  'Sharpe и Sortino считаются по дневному результату в ₽ (капитала у системы нет), ' +
  'безрисковая ставка = 0, годовая нормировка × √252. Дни — все будни между первой и ' +
  'последней датой закрытия (дни без сделок = 0) плюс выходные с результатом. Sharpe: ' +
  'среднее / выборочное σ; Sortino: среднее / нижнее отклонение от 0.';

/**
 * Статистика системы по её сделкам. `trades` — сделки ОДНОЙ системы (срез по системе,
 * портфелю и периоду делает вызывающий). Закрытые сделки дают все показатели; открытые
 * (Open/Partial) — только блоки «открытый результат».
 */
export function systemPerformance(
  trades: readonly TradeResult[],
  options: PerformanceOptions = {},
): SystemPerformanceBody {
  const closed = trades.filter((t) => t.status === 'Closed' && t.closedAt).sort(byCloseOrder);
  const open = trades.filter((t) => t.status !== 'Closed');
  const pnls = closed.map((t) => t.realizedPnlRub);

  const out = outcomeStats(pnls);
  const net = pnls.reduce((s, x) => s.plus(x), ZERO);
  const feesClosed = closed.reduce((s, t) => s.plus(t.feesRub), ZERO);
  const gross = net.plus(feesClosed);
  const feesTotal = trades.reduce((s, t) => s.plus(t.feesRub), ZERO);
  const openRealized = open.reduce((s, t) => s.plus(t.realizedPnlRub), ZERO);
  const income = trades.reduce((s, t) => s.plus(t.dividendsRub).plus(t.couponsRub), ZERO);
  const openIncome = open.reduce((s, t) => s.plus(t.dividendsRub).plus(t.couponsRub), ZERO);
  const unrealized = open.reduce(
    (s, t) => s.plus(options.unrealizedOf?.(t) ?? ZERO),
    ZERO,
  );

  // ── качество
  const wins = pnls.filter((x) => x.gt(0));
  const losses = pnls.filter((x) => x.lt(0));
  const avgWin = out.wins > 0 ? out.grossProfit.div(out.wins) : ZERO;
  const avgLoss = out.losses > 0 ? out.grossLoss.div(out.losses).neg() : ZERO;

  // ── направления
  const byDirection = (dir: 'Long' | 'Short') => {
    const rs = closed.filter((t) => t.direction === dir).map((t) => t.realizedPnlRub);
    const o = outcomeStats(rs);
    return {
      count: o.count,
      wins: o.wins,
      winRatePct: o.winRatePct,
      netPnlRub: money(rs.reduce((s, x) => s.plus(x), ZERO)),
    };
  };

  // ── серии (безубыточная сделка серию обрывает)
  let maxWins = 0;
  let maxLosses = 0;
  let runKind: 'win' | 'loss' | null = null;
  let runLen = 0;
  for (const r of pnls) {
    const kind = r.gt(0) ? 'win' : r.lt(0) ? 'loss' : null;
    if (kind !== null && kind === runKind) runLen++;
    else {
      runKind = kind;
      runLen = kind === null ? 0 : 1;
    }
    if (runKind === 'win') maxWins = Math.max(maxWins, runLen);
    if (runKind === 'loss') maxLosses = Math.max(maxLosses, runLen);
  }

  // ── эквити: точка на день по дате закрытия, стартовый ноль в день до первой
  // сделки (или в день её открытия, если он раньше)
  const dailyPnl = new Map<string, Decimal>();
  for (const t of closed) {
    const day = t.closedAt as string;
    dailyPnl.set(day, (dailyPnl.get(day) ?? ZERO).plus(t.realizedPnlRub));
  }
  const days = [...dailyPnl.keys()].sort();
  const equityDates: string[] = [];
  const equityValues: Decimal[] = [];
  if (days.length > 0) {
    const firstOpened = closed.map((t) => t.openedAt).sort()[0];
    const start = firstOpened < days[0] ? firstOpened : addDays(days[0], -1);
    equityDates.push(start);
    equityValues.push(ZERO);
    let acc = ZERO;
    for (const day of days) {
      acc = acc.plus(dailyPnl.get(day) as Decimal);
      equityDates.push(day);
      equityValues.push(acc);
    }
  }
  const dd = absoluteDrawdown(equityValues);
  const equity = equityDates.map((date, i) => ({
    date,
    equityRub: money(equityValues[i]),
    drawdownRub: money(dd.series[i]),
  }));
  const recoveryDate = dd.recoveryIndex === null ? null : equityDates[dd.recoveryIndex];
  const lastDate = equityDates[equityDates.length - 1];
  const drawdownDays =
    dd.peakIndex === null
      ? 0
      : daysBetween(equityDates[dd.peakIndex], recoveryDate ?? lastDate);

  // ── срок удержания
  const hold = closed.map((t) => ({ ...holdingHours(t), pnl: t.realizedPnlRub }));
  const holdOf = (pred: (pnl: Decimal) => boolean): number | null =>
    mean(hold.filter((h) => pred(h.pnl)).map((h) => h.hours));

  // ── Sharpe / Sortino по дневному P&L
  const daily: number[] = [];
  if (days.length > 0) {
    for (let d = days[0]; d <= days[days.length - 1]; d = addDays(d, 1)) {
      const wd = isoWeekday(d);
      const pnl = dailyPnl.get(d);
      if (wd <= 5 || pnl) daily.push(pnl ? pnl.toNumber() : 0);
    }
  }
  const mu = mean(daily);
  let sharpe: number | null = null;
  let sortino: number | null = null;
  if (mu !== null && daily.length >= 2) {
    const variance = daily.reduce((s, x) => s + (x - mu) ** 2, 0) / (daily.length - 1);
    const sigma = Math.sqrt(variance);
    if (sigma > 0) sharpe = (mu / sigma) * Math.sqrt(252);
    const downside = Math.sqrt(daily.reduce((s, x) => s + Math.min(x, 0) ** 2, 0) / daily.length);
    if (downside > 0) sortino = (mu / downside) * Math.sqrt(252);
  }

  // ── разрезы
  const monthly = new Map<string, { pnl: Decimal; n: number }>();
  const weekly = new Map<number, { pnl: Decimal; n: number }>();
  for (const t of closed) {
    const m = (t.closedAt as string).slice(0, 7);
    const w = isoWeekday(t.closedAt as string);
    const mb = monthly.get(m) ?? { pnl: ZERO, n: 0 };
    monthly.set(m, { pnl: mb.pnl.plus(t.realizedPnlRub), n: mb.n + 1 });
    const wb = weekly.get(w) ?? { pnl: ZERO, n: 0 };
    weekly.set(w, { pnl: wb.pnl.plus(t.realizedPnlRub), n: wb.n + 1 });
  }

  const last = pnls[pnls.length - 1];
  return {
    execution: executionStats(trades, closed, options.fills),
    summary: {
      netPnlRub: money(net),
      grossPnlRub: money(gross),
      feesRub: money(feesClosed),
      feesTotalRub: money(feesTotal),
      feeSharePct: gross.gt(0) ? feesClosed.div(gross).mul(100).toNumber() : null,
      openRealizedRub: money(openRealized),
      unrealizedRub: money(unrealized),
      incomeRub: money(income),
      closedResultRub: money(net.plus(income).minus(openIncome)),
      closedIncomeRub: money(income.minus(openIncome)),
      openIncomeRub: money(openIncome),
      openResultRub: money(unrealized.plus(openRealized).plus(openIncome)),
      totalRub: money(net.plus(openRealized).plus(unrealized).plus(income)),
      openCount: open.length,
    },
    trades: {
      closed: out.count,
      wins: out.wins,
      losses: out.losses,
      breakeven: out.breakeven,
      winRatePct: out.winRatePct,
      long: byDirection('Long'),
      short: byDirection('Short'),
    },
    quality: {
      avgWinRub: money(avgWin),
      avgLossRub: money(avgLoss),
      payoffRatio: out.losses > 0 && out.wins > 0 ? avgWin.div(avgLoss.abs()).toNumber() : null,
      profitFactor: out.profitFactor,
      expectancyRub: money(out.count > 0 ? net.div(out.count) : ZERO),
      largestWinRub: money(wins.length ? Decimal.max(...wins) : ZERO),
      largestLossRub: money(losses.length ? Decimal.min(...losses) : ZERO),
    },
    streaks: {
      maxWins,
      maxLosses,
      current: {
        kind: last === undefined ? null : last.gt(0) ? 'win' : last.lt(0) ? 'loss' : null,
        length: runKind === null ? 0 : runLen,
      },
    },
    risk: {
      maxDrawdownRub: money(dd.maxDrawdown),
      peakDate: dd.peakIndex === null ? null : equityDates[dd.peakIndex],
      troughDate: dd.troughIndex === null ? null : equityDates[dd.troughIndex],
      recoveryDate,
      drawdownDays,
      recoveryFactor: dd.maxDrawdown.gt(0) ? net.div(dd.maxDrawdown).toNumber() : null,
    },
    holding: {
      hasTime: hold.length > 0 && hold.every((h) => h.timed),
      avgHours: holdOf(() => true),
      avgWinHours: holdOf((p) => p.gt(0)),
      avgLossHours: holdOf((p) => p.lt(0)),
    },
    ratios: { sharpe, sortino, days: daily.length, assumptions: RATIO_ASSUMPTIONS },
    series: {
      equity,
      byMonth: [...monthly.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([period, v]) => ({ period, pnlRub: money(v.pnl), trades: v.n })),
      byWeekday: [...weekly.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([weekday, v]) => ({ weekday, pnlRub: money(v.pnl), trades: v.n })),
      histogram: buildHistogram(pnls),
    },
  };
}
