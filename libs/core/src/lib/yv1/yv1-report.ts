import Decimal from 'decimal.js';
import { z } from 'zod';
import type { SnapshotAssessment, SnapshotTables } from './qsnap';
import {
  extractAccountState,
  extractCalcTrades,
  extractTrades,
  type QsnapTrade,
} from './qsnap-extract';
import type {
  AutomatDay,
  AutomatLogDay,
  AutomatSignal,
  AutomatTrade,
  SizingDay,
} from './yv1-automat';
import {
  checkCalcTrades,
  checkCoverage,
  checkSignals,
  checkSnapshotPosition,
  moneyIdentity,
  verifiableDates,
  verifiableUntil,
  type MoneyIdentity,
} from './yv1-checks';
import { buildCycles, type FeeRounding } from './yv1-cycles';
import { buildFills, type SnapshotTrade } from './yv1-fills';
import {
  CONTRACT_MULTIPLIER,
  DiscrepancySchema,
  MIN_CYCLES_FOR_VERDICT,
  isCrContract,
  type Discrepancy,
} from './yv1-types';

Decimal.set({ precision: 40 });

/* ------------------------------------------------------------------ схемы (контракт с фронтом) */

const money = z.string();

export const Yv1CycleSchema = z.object({
  id: z.string(),
  openDate: z.string(),
  closeDate: z.string().nullable(),
  status: z.enum(['open', 'partial', 'closed']),
  direction: z.enum(['long', 'short', 'mixed']),
  contracts: z.array(z.string()),
  entryQty: money,
  exitQty: money,
  openQty: money,
  avgEntryPrice: money.nullable(),
  avgExitPrice: money.nullable(),
  legs: z.array(
    z.object({
      tradeNum: z.string(),
      date: z.string(),
      time: z.string(),
      contract: z.string(),
      side: z.enum(['B', 'S']),
      role: z.enum(['entry', 'exit']),
      reason: z.string().nullable(),
      qty: money,
      fillQty: money,
      price: money,
    }),
  ),
  pnlPrice: money,
  costs: z.object({
    brokerModel: money,
    brokerQuik: money,
    exchange: money,
    clearing: money,
    techCenter: money,
    total: money,
    complete: z.boolean(),
  }),
  debtInterest: money,
  netRub: money,
  slipEntryRub: money.nullable(),
  slipEntryAutomatRub: money.nullable(),
  slipExitRub: money.nullable(),
  flags: z.array(z.string()),
  /** net к начальному капиталу, % (null — капитал не задан) */
  retInitialPct: z.number().nullable(),
  /** net к капиталу на момент входа (начальный + net закрытых до этого циклов), % */
  retCurrentPct: z.number().nullable(),
});
export type Yv1CycleView = z.infer<typeof Yv1CycleSchema>;

const CurvePointSchema = z.object({ date: z.string(), ret: z.number(), equity: z.number() });
export type Yv1CurvePoint = z.infer<typeof CurvePointSchema>;

export const Yv1OverviewSchema = z.object({
  generatedAt: z.string(),
  settings: z.object({
    initialCapital: money.nullable(),
    capitalSource: z.enum(['settings', 'automat-log']).nullable(),
    feeRounding: z.enum(['ceil', 'half-up']),
    debtRatePerDay: z.string(),
    backtestScale: z.string(),
  }),
  verdict: z.object({
    closedCycles: z.number(),
    minForVerdict: z.number(),
    status: z.enum(['preliminary', 'no-corridor', 'inside', 'outside']),
    note: z.string(),
  }),
  bridge: z.object({
    lastComplete: z
      .object({
        snapId: z.string(),
        localTime: z.string(),
        tradeDate: z.string(),
        scriptVersion: z.string(),
        ageMinutes: z.number().nullable(),
      })
      .nullable(),
    snapshots: z.array(
      z.object({
        snapId: z.string(),
        localTime: z.string(),
        tradeDate: z.string(),
        scriptVersion: z.string(),
        status: z.string(),
        complete: z.boolean(),
        reasons: z.array(z.string()),
        clockSkewSec: z.number().nullable(),
        rawLines: z.number(),
      }),
    ),
    unfinished: z.array(z.string()),
    coverage: z.object({
      tradingDays: z.array(z.string()),
      covered: z.array(z.string()),
      holes: z.array(z.object({ date: z.string(), reason: z.string() })),
    }),
  }),
  cycles: z.array(Yv1CycleSchema),
  months: z.array(
    z.object({
      month: z.string(),
      cycles: z.number(),
      wins: z.number(),
      netRub: money,
      feesRub: money,
      retInitialPct: z.number().nullable(),
    }),
  ),
  position: z
    .object({
      contract: z.string(),
      bridgeNet: money.nullable(),
      journalNet: money,
      asOf: z.string().nullable(),
      lastPrice: money.nullable(),
      settlePrice: money.nullable(),
      /** индикативно: по LAST против средней цены открытых лотов */
      unrealizedRub: money.nullable(),
    })
    .nullable(),
  costs: z.object({
    brokerModel: money,
    brokerQuik: money,
    exchange: money,
    clearing: money,
    total: money,
    /** QUIK / модель по брокерской части; в отчёте Сбера ≈ 2.64 */
    quikToModelRatio: z.number().nullable(),
    complete: z.boolean(),
    calcTrades: z.object({ rows: z.number(), maxBrokerDiff: z.string() }).nullable(),
  }),
  slippage: z.object({
    entryRub: money.nullable(),
    entryAutomatRub: money.nullable(),
    exitRub: money.nullable(),
  }),
  vmDays: z.array(
    z.object({
      date: z.string(),
      valueRub: money,
      status: z.enum(['accrued', 'posted']),
      source: z.enum(['bridge', 'automat']),
    }),
  ),
  completeness: z.array(
    z.object({
      snapId: z.string(),
      tradeDate: z.string(),
      applicable: z.boolean(),
      note: z.string().nullable(),
      t1Open: money.nullable(),
      t1Current: money.nullable(),
      delta: money.nullable(),
      components: z.array(z.object({ group: z.string(), label: z.string(), amountRub: money })),
      explained: money.nullable(),
      residual: money.nullable(),
      ok: z.boolean().nullable(),
    }),
  ),
  discrepancies: z.array(DiscrepancySchema),
  sizing: z.array(
    z.object({
      date: z.string(),
      dryRun: z.boolean(),
      halfQty: z.number().nullable(),
      capital: z.string().nullable(),
      leverage: z.string(),
      maxGross: z.number(),
    }),
  ),
  curve: z.array(CurvePointSchema).nullable(),
  backtest: z
    .object({
      scale: z.string(),
      lastDate: z.string(),
      points: z.array(CurvePointSchema),
    })
    .nullable(),
  counts: z.object({
    fills: z.number(),
    yv1: z.number(),
    unallocated: z.number(),
    /** сделки журналов других стратегий на счёте — в расчёт этой стратегии не входят */
    otherStrategy: z.number().default(0),
    snapshotsComplete: z.number(),
  }),
});
export type Yv1Overview = z.infer<typeof Yv1OverviewSchema>;

/* ------------------------------------------------------------------ вход сборщика */

export interface Yv1SnapshotInput {
  assessment: SnapshotAssessment;
  /** таблицы есть только у целых снимков */
  tables: SnapshotTables | null;
}

export interface Yv1Corridor {
  /** заранее заданный коридор среднего net на цикл, % к начальному капиталу; null — граница не задана */
  netPerCycleRetPct: { min: number | null; max: number | null };
  /** не меньше MIN_CYCLES_FOR_VERDICT */
  minCycles: number;
}

export interface Yv1OverviewInput {
  /** момент «сейчас», МСК */
  now: string;
  snapshots: readonly Yv1SnapshotInput[];
  unfinished: readonly string[];
  automat: {
    trades: readonly AutomatTrade[];
    daily: readonly AutomatDay[];
    signals: readonly AutomatSignal[];
    logs: readonly AutomatLogDay[];
  };
  settings: {
    initialCapital: string | null;
    feeRounding: FeeRounding;
    debtRatePerDay: string;
    backtestScale: string | null;
  };
  backtest: readonly { date: string; ret: number }[] | null;
  corridor: Yv1Corridor | null;
  exitRefPrices?: ReadonlyMap<string, string>;
  /** номера сделок из журналов других стратегий на этом счёте (не «не распределено») */
  otherStrategyTradeNums?: ReadonlySet<string>;
}

/* ------------------------------------------------------------------ вспомогательное */

const pct = (num: Decimal, den: Decimal | null): number | null =>
  den === null || den.lte(0) ? null : Number(num.div(den).mul(100).toFixed(4));

/** Кривая бэктеста с множителем масштаба номинала: equity пересобирается от 1 */
export function scaleCurve(
  points: readonly { date: string; ret: number }[],
  scale: string,
): Yv1CurvePoint[] {
  const k = new Decimal(scale);
  let eq = new Decimal(1);
  return points.map((p) => {
    const r = new Decimal(p.ret).mul(k);
    eq = eq.mul(r.plus(1));
    return { date: p.date, ret: Number(r.toFixed(12)), equity: Number(eq.toFixed(12)) };
  });
}

/** Контракт формата «date,ret,equity» (как daily_yv1_2vh.csv) */
export function curveToCsv(points: readonly Yv1CurvePoint[]): string {
  return ['date,ret,equity', ...points.map((p) => `${p.date},${p.ret},${p.equity}`)].join('\n') + '\n';
}

function minutesBetween(from: string, to: string): number | null {
  const a = Date.parse(from.replace(' ', 'T') + 'Z');
  const b = Date.parse(to.replace(' ', 'T') + 'Z');
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 60000) : null;
}

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 } as const;

/* ------------------------------------------------------------------ сборка обзора */

export function buildYv1Overview(input: Yv1OverviewInput): Yv1Overview {
  const discrepancies: Discrepancy[] = [];
  const assessments = input.snapshots.map((s) => s.assessment);
  const complete = input.snapshots.filter((s) => s.assessment.complete && s.tables);

  // 1) таблицы целых снимков → сделки, расчётные комиссии, состояние счёта
  const qsnapTrades: SnapshotTrade[] = [];
  const perSnapshot = complete.map((s) => {
    const tables = s.tables as SnapshotTables;
    const trades = extractTrades(tables);
    for (const t of trades) qsnapTrades.push({ ...t, snapId: s.assessment.snapId });
    return {
      snapId: s.assessment.snapId,
      tradeDate: s.assessment.index.tradeDate,
      localTime: s.assessment.index.localTime,
      trades,
      calc: extractCalcTrades(tables),
      state: extractAccountState(tables),
    };
  });

  // 2) принадлежность и сверка
  const { fills, otherStrategyTrades, discrepancies: fillDiscrepancies } = buildFills({
    qsnapTrades,
    automatTrades: input.automat.trades,
    verifiableDates: verifiableDates(assessments),
    verifiableUntil: verifiableUntil(assessments),
    otherStrategyTradeNums: input.otherStrategyTradeNums,
  });
  discrepancies.push(...fillDiscrepancies);

  const automatNums = new Set(input.automat.trades.map((t) => t.tradeNum));
  const yv1Accounts = new Set<string>();
  for (const s of perSnapshot) {
    for (const t of s.trades) if (automatNums.has(t.tradeNum) && t.account) yv1Accounts.add(t.account);
  }

  // 3) ряд рублей Т0 (утро) для модели процентов по долгу
  const rubSeries = new Map<string, string>();
  for (const d of input.automat.daily) if (d.t0Start !== null) rubSeries.set(d.date, d.t0Start);
  for (const s of perSnapshot) if (s.state.money) rubSeries.set(s.tradeDate, s.state.money.t0Open);

  // 4) циклы
  const { cycles: rawCycles, discrepancies: cycleDiscrepancies } = buildCycles(fills, {
    rounding: input.settings.feeRounding,
    rubSeries,
    exitRefPrices: input.exitRefPrices,
    debtRatePerDay: input.settings.debtRatePerDay,
  });
  discrepancies.push(...cycleDiscrepancies);

  // 5) знаменатель
  const sizing: SizingDay[] = input.automat.logs.flatMap((l) => (l.sizing ? [l.sizing] : []));
  sizing.sort((a, b) => a.date.localeCompare(b.date));
  const logCapital = [...sizing].reverse().find((s) => s.capital !== null)?.capital ?? null;
  const initialCapital = input.settings.initialCapital ?? logCapital;
  const capitalSource = input.settings.initialCapital ? 'settings' : logCapital ? 'automat-log' : null;
  const initial = initialCapital ? new Decimal(initialCapital) : null;

  const cycles: Yv1CycleView[] = rawCycles.map((c) => {
    const net = new Decimal(c.netRub);
    const realizedBefore = rawCycles
      .filter((o) => o.closeDate !== null && o.closeDate < c.openDate)
      .reduce((a, o) => a.plus(o.netRub), new Decimal(0));
    return {
      ...c,
      retInitialPct: pct(net, initial),
      retCurrentPct: pct(net, initial === null ? null : initial.plus(realizedBefore)),
    };
  });
  const closed = cycles.filter((c) => c.status === 'closed');

  // 6) месяцы по дате закрытия
  const monthMap = new Map<string, { cycles: number; wins: number; net: Decimal; fees: Decimal }>();
  for (const c of closed) {
    const key = (c.closeDate as string).slice(0, 7);
    const m = monthMap.get(key) ?? { cycles: 0, wins: 0, net: new Decimal(0), fees: new Decimal(0) };
    m.cycles++;
    if (new Decimal(c.netRub).gt(0)) m.wins++;
    m.net = m.net.plus(c.netRub);
    m.fees = m.fees.plus(c.costs.total);
    monthMap.set(key, m);
  }
  const months = [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, m]) => ({
      month,
      cycles: m.cycles,
      wins: m.wins,
      netRub: m.net.toFixed(2),
      feesRub: m.fees.toFixed(2),
      retInitialPct: pct(m.net, initial),
    }));

  // 7) кривая: ret закрытых в день циклов к капиталу на начало дня
  const tradingDaySet = new Set<string>([
    ...input.automat.daily.map((d) => d.date),
    ...input.automat.signals.map((s) => s.date),
    ...fills.filter((f) => f.allocation === 'yv1').map((f) => f.date),
  ]);
  let curve: Yv1CurvePoint[] | null = null;
  if (initial && closed.length > 0) {
    const firstDay = closed.reduce((m, c) => (c.openDate < m ? c.openDate : m), closed[0].openDate);
    const days = [...tradingDaySet, ...closed.map((c) => c.closeDate as string)]
      .filter((d) => d >= firstDay)
      .filter((d, i, a) => a.indexOf(d) === i)
      .sort();
    let capital = initial;
    let eq = new Decimal(1);
    curve = days.map((date) => {
      const net = closed
        .filter((c) => c.closeDate === date)
        .reduce((a, c) => a.plus(c.netRub), new Decimal(0));
      const r = capital.gt(0) ? net.div(capital) : new Decimal(0);
      capital = capital.plus(net);
      eq = eq.mul(r.plus(1));
      return { date, ret: Number(r.toFixed(12)), equity: Number(eq.toFixed(12)) };
    });
  }

  // 8) проверки
  const coverage = checkCoverage({
    tradingDays: [...tradingDaySet],
    snapshots: assessments,
    now: input.now,
  });
  for (const h of coverage.holes) {
    discrepancies.push({ kind: 'coverage-hole', severity: 'warn', date: h.date, tradeNum: null, message: `${h.date}: ${h.reason}` });
  }
  for (const a of assessments.filter((x) => !x.complete)) {
    discrepancies.push({
      kind: 'incomplete-snapshot',
      severity: 'warn',
      date: a.index.tradeDate,
      tradeNum: null,
      message: `Снимок ${a.snapId} не целый (${a.reasons.join('; ')}) — в расчёт не идёт`,
    });
  }
  for (const id of input.unfinished) {
    discrepancies.push({
      kind: 'unfinished-snapshot',
      severity: 'warn',
      date: null,
      tradeNum: null,
      message: `Снимок ${id} без строки в индексе — незавершённый, в расчёт не идёт`,
    });
  }
  discrepancies.push(...checkSignals(input.automat.signals, fills, input.automat.logs));

  const completeness: MoneyIdentity[] = [];
  let calcRows = 0;
  let calcMax = new Decimal(0);
  for (const s of perSnapshot) {
    discrepancies.push(...checkSnapshotPosition(s.snapId, s.trades, s.state.holdings));
    const calcCheck = checkCalcTrades(s.calc, s.trades, input.settings.feeRounding);
    calcRows += calcCheck.rows;
    if (new Decimal(calcCheck.maxBrokerDiff).gt(calcMax)) calcMax = new Decimal(calcCheck.maxBrokerDiff);
    discrepancies.push(...calcCheck.discrepancies);
    const id = moneyIdentity({
      snapId: s.snapId,
      tradeDate: s.tradeDate,
      trades: s.trades,
      automatTradeNums: automatNums,
      otherStrategyTradeNums: input.otherStrategyTradeNums,
      money: s.state.money,
      holdings: s.state.holdings,
    });
    completeness.push(id);
    if (id.applicable && id.ok === false) {
      discrepancies.push({
        kind: 'money-identity',
        severity: 'error',
        date: s.tradeDate,
        tradeNum: null,
        message: `Тест полноты, снимок ${s.snapId}: рубли Т1 изменились на ${id.delta}, объяснено ${id.explained}, невязка ${id.residual} ₽`,
      });
    }
    if (s.state.money?.ambiguous) {
      discrepancies.push({
        kind: 'money-ambiguous',
        severity: 'warn',
        date: s.tradeDate,
        tradeNum: null,
        message: `Снимок ${s.snapId}: несколько клиентских кодов с рублями Т0 — взят первый`,
      });
    }
  }

  // 9) ВМ по дням счёта: последняя запись на торговую дату по каждому источнику
  const vmByKey = new Map<string, { date: string; valueRub: string; status: 'accrued' | 'posted'; source: 'bridge' | 'automat' }>();
  for (const d of input.automat.daily) {
    if (d.vm !== null) vmByKey.set(`${d.date}|automat`, { date: d.date, valueRub: d.vm, status: 'accrued', source: 'automat' });
  }
  for (const s of [...perSnapshot].sort((a, b) => a.snapId.localeCompare(b.snapId))) {
    const rows = s.state.holdings.filter(
      (h) => isCrContract(h.secCode) && (yv1Accounts.size === 0 || yv1Accounts.has(h.account)),
    );
    if (rows.length === 0) continue;
    const value = rows.reduce((a, h) => a.plus(h.varMargin), new Decimal(0));
    const posted = rows.some((h) => !new Decimal(h.realVarMargin).isZero());
    vmByKey.set(`${s.tradeDate}|bridge`, { date: s.tradeDate, valueRub: value.toFixed(2), status: posted ? 'posted' : 'accrued', source: 'bridge' });
  }
  const vmDays = [...vmByKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source));

  // 10) позиция
  const lastSnap = [...perSnapshot].sort((a, b) => a.snapId.localeCompare(b.snapId)).at(-1);
  // Контракт позиции — по порядку сделок, а не по алфавиту (после ролловера CRH7 «меньше» CRZ6):
  // последний контракт с ненулевой позицией по журналу, иначе контракт последней сделки.
  const yv1Fills = fills.filter((f) => f.allocation === 'yv1' && f.side !== null);
  const netByContract = new Map<string, Decimal>();
  for (const f of yv1Fills) {
    netByContract.set(
      f.contract,
      (netByContract.get(f.contract) ?? new Decimal(0)).plus(f.side === 'B' ? f.qty : new Decimal(f.qty).neg()),
    );
  }
  const lastFirst = [...new Set(yv1Fills.map((f) => f.contract).reverse())];
  const posContract = lastFirst.find((c) => !(netByContract.get(c) as Decimal).isZero()) ?? lastFirst[0] ?? null;
  const position = posContract
    ? (() => {
        const journalNet = fills
          .filter((f) => f.contract === posContract && f.side !== null)
          .reduce((a, f) => a.plus(f.side === 'B' ? f.qty : new Decimal(f.qty).neg()), new Decimal(0));
        const hold = lastSnap?.state.holdings.filter(
          (h) => h.secCode === posContract && (yv1Accounts.size === 0 || yv1Accounts.has(h.account)),
        );
        const bridgeNet = hold && hold.length > 0 ? hold.reduce((a, h) => a.plus(h.totalNet), new Decimal(0)) : null;
        const last = lastSnap?.state.params[`SPBFUT:${posContract}:LAST`] ?? null;
        const settle = lastSnap?.state.params[`SPBFUT:${posContract}:SETTLEPRICE`] ?? null;
        // индикативная нереализованная часть: открытые лоты по средней цене входа против LAST
        const open = cycles.filter((c) => c.status !== 'closed' && c.contracts.includes(posContract));
        let unrealized: string | null = null;
        if (last !== null && open.length > 0) {
          unrealized = open
            .reduce((a, c) => {
              const sign = c.direction === 'short' ? -1 : 1;
              return c.avgEntryPrice === null
                ? a
                : a.plus(new Decimal(last).minus(c.avgEntryPrice).mul(sign).mul(c.openQty).mul(CONTRACT_MULTIPLIER));
            }, new Decimal(0))
            .toFixed(2);
        }
        if (bridgeNet !== null && !bridgeNet.eq(journalNet)) {
          discrepancies.push({
            kind: 'position-mismatch',
            severity: 'warn',
            date: lastSnap?.tradeDate ?? null,
            tradeNum: null,
            message: `Позиция ${posContract}: в последнем снимке ${bridgeNet.toFixed()}, по журналу сделок ${journalNet.toFixed()}`,
          });
        }
        return {
          contract: posContract,
          bridgeNet: bridgeNet?.toFixed() ?? null,
          journalNet: journalNet.toFixed(),
          asOf: lastSnap?.localTime ?? null,
          lastPrice: last,
          settlePrice: settle,
          unrealizedRub: unrealized,
        };
      })()
    : null;

  // 11) издержки и проскальзывание
  const sum = (f: (c: Yv1CycleView) => string): Decimal => cycles.reduce((a, c) => a.plus(f(c)), new Decimal(0));
  const brokerModel = sum((c) => c.costs.brokerModel);
  const brokerQuik = sum((c) => c.costs.brokerQuik);
  const slipSum = (pick: (c: Yv1CycleView) => string | null): string | null => {
    const vals = cycles.map(pick).filter((v): v is string => v !== null);
    return vals.length === 0 ? null : vals.reduce((a, v) => a.plus(v), new Decimal(0)).toFixed(2);
  };

  // 12) вердикт
  const needed = Math.max(MIN_CYCLES_FOR_VERDICT, input.corridor?.minCycles ?? 0);
  let verdict: Yv1Overview['verdict'];
  if (closed.length < needed) {
    verdict = {
      closedCycles: closed.length,
      minForVerdict: needed,
      status: 'preliminary',
      note: `Закрытых циклов ${closed.length} из ${needed} — вердиктов нет, цифры предварительные`,
    };
  } else if (
    !input.corridor ||
    (input.corridor.netPerCycleRetPct.min === null && input.corridor.netPerCycleRetPct.max === null)
  ) {
    verdict = { closedCycles: closed.length, minForVerdict: needed, status: 'no-corridor', note: 'Коридор не задан (docs/yv1-corridor.json: обе границы null) — сравнивать не с чем' };
  } else {
    const rets = closed.map((c) => c.retInitialPct).filter((v): v is number => v !== null);
    const mean = rets.length === 0 ? null : rets.reduce((a, v) => a + v, 0) / rets.length;
    const { min, max } = input.corridor.netPerCycleRetPct;
    const inside = mean !== null && (min === null || mean >= min) && (max === null || mean <= max);
    verdict = {
      closedCycles: closed.length,
      minForVerdict: needed,
      status: mean === null ? 'no-corridor' : inside ? 'inside' : 'outside',
      note: mean === null ? 'Капитал не задан — доходность не посчитать' : `Средний net на цикл ${mean.toFixed(3)} % к начальному капиталу, коридор [${min ?? '−∞'}; ${max ?? '+∞'}]`,
    };
  }

  // 13) бэктест
  const scale = input.settings.backtestScale ?? sizing.at(-1)?.leverage ?? '1';
  const backtest = input.backtest && input.backtest.length > 0
    ? { scale, lastDate: input.backtest[input.backtest.length - 1].date, points: scaleCurve(input.backtest, scale) }
    : null;

  const lastComplete = [...assessments].filter((a) => a.complete).sort((a, b) => a.snapId.localeCompare(b.snapId)).at(-1);

  return {
    generatedAt: input.now,
    settings: {
      initialCapital,
      capitalSource,
      feeRounding: input.settings.feeRounding,
      debtRatePerDay: input.settings.debtRatePerDay,
      backtestScale: scale,
    },
    verdict,
    bridge: {
      lastComplete: lastComplete
        ? {
            snapId: lastComplete.snapId,
            localTime: lastComplete.index.localTime,
            tradeDate: lastComplete.index.tradeDate,
            scriptVersion: lastComplete.index.scriptVersion,
            ageMinutes: minutesBetween(lastComplete.index.localTime, input.now),
          }
        : null,
      snapshots: assessments
        .map((a) => ({
          snapId: a.snapId,
          localTime: a.index.localTime,
          tradeDate: a.index.tradeDate,
          scriptVersion: a.index.scriptVersion,
          status: a.index.status,
          complete: a.complete,
          reasons: a.reasons,
          clockSkewSec: a.clockSkewSec,
          rawLines: a.index.rawLines,
        }))
        .sort((a, b) => b.snapId.localeCompare(a.snapId)),
      unfinished: [...input.unfinished],
      coverage,
    },
    cycles: cycles.sort((a, b) => b.id.localeCompare(a.id)),
    months,
    position,
    costs: {
      brokerModel: brokerModel.toFixed(2),
      brokerQuik: brokerQuik.toFixed(2),
      exchange: sum((c) => c.costs.exchange).toFixed(2),
      clearing: sum((c) => c.costs.clearing).toFixed(2),
      total: sum((c) => c.costs.total).toFixed(2),
      quikToModelRatio: brokerModel.isZero() ? null : Number(brokerQuik.div(brokerModel).toFixed(3)),
      complete: cycles.every((c) => c.costs.complete),
      calcTrades: calcRows > 0 ? { rows: calcRows, maxBrokerDiff: calcMax.toFixed(2) } : null,
    },
    slippage: {
      entryRub: slipSum((c) => c.slipEntryRub),
      entryAutomatRub: slipSum((c) => c.slipEntryAutomatRub),
      exitRub: slipSum((c) => c.slipExitRub),
    },
    vmDays,
    completeness,
    discrepancies: discrepancies.sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        (b.date ?? '').localeCompare(a.date ?? ''),
    ),
    sizing,
    curve,
    backtest,
    counts: {
      fills: fills.length,
      yv1: fills.filter((f) => f.allocation === 'yv1').length,
      unallocated: fills.filter((f) => f.allocation === 'unallocated').length,
      otherStrategy: otherStrategyTrades.length,
      snapshotsComplete: complete.length,
    },
  };
}

export type { QsnapTrade };
