import Decimal from 'decimal.js';
import type { SnapshotAssessment } from './qsnap';
import type {
  QsnapCalcTrade,
  QsnapHolding,
  QsnapMoney,
  QsnapTrade,
} from './qsnap-extract';
import type { AutomatLogDay, AutomatSignal } from './yv1-automat';
import { DEFAULT_FEE_ROUNDING, modelBrokerFee, type FeeRounding } from './yv1-cycles';
import type { Yv1Fill } from './yv1-fills';
import { isCrContract, type Discrepancy } from './yv1-types';

Decimal.set({ precision: 40 });

/** Вечерний клиринг на FORTS заканчивается около 19:05; снимок «после клиринга» — с 19:10 МСК */
export const EVENING_CLEARING_DONE = '19:10:00';

export interface CoverageHole {
  date: string;
  reason: string;
}

export interface Coverage {
  tradingDays: string[];
  /** дни с целым снимком после вечернего клиринга */
  covered: string[];
  holes: CoverageHole[];
}

/**
 * Контроль «в каждом торговом дне есть целый снимок после вечернего клиринга».
 * Подходит снимок, у которого: целый, trade_date = день, local_time ≥ 19:10 этого дня
 * (МСК, правило времени — в qsnap.ts). Текущий день до 19:10 дырой не считается.
 */
export function checkCoverage(input: {
  tradingDays: readonly string[];
  snapshots: readonly SnapshotAssessment[];
  /** момент «сейчас», МСК `YYYY-MM-DD HH:MM:SS` */
  now: string;
}): Coverage {
  const days = [...new Set(input.tradingDays)].sort();
  const covered: string[] = [];
  const holes: CoverageHole[] = [];
  for (const day of days) {
    if (input.now < `${day} ${EVENING_CLEARING_DONE}`) continue;
    const forDay = input.snapshots.filter((s) => s.index.tradeDate === day);
    const ok = forDay.find((s) => s.complete && s.index.localTime >= `${day} ${EVENING_CLEARING_DONE}`);
    if (ok) {
      covered.push(day);
    } else if (forDay.length === 0) {
      holes.push({ date: day, reason: 'нет ни одного снимка за торговую дату' });
    } else if (forDay.every((s) => !s.complete)) {
      holes.push({ date: day, reason: 'снимки есть, но ни один не целый' });
    } else {
      holes.push({ date: day, reason: 'целые снимки сняты до вечернего клиринга (раньше 19:10)' });
    }
  }
  return { tradingDays: days, covered, holes };
}

/** Торговые даты, для которых в мосте есть целый снимок: только по ним «нет сделки в мосте» что-то значит */
export function verifiableDates(snapshots: readonly SnapshotAssessment[]): Set<string> {
  return new Set(snapshots.filter((s) => s.complete).map((s) => s.index.tradeDate));
}

/**
 * До какого момента (local_time, МСК) по каждой торговой дате есть целый снимок: сделка автомата,
 * совершённая ПОЗЖЕ последнего снимка дня, в нём появиться не могла — «нет в мосте» тут ничего не значит.
 */
export function verifiableUntil(snapshots: readonly SnapshotAssessment[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of snapshots) {
    if (!s.complete) continue;
    const prev = out.get(s.index.tradeDate);
    if (prev === undefined || s.index.localTime > prev) out.set(s.index.tradeDate, s.index.localTime);
  }
  return out;
}

/**
 * Сверка сигналов автомата с фактическими сделками: пропущенные половины, частичные
 * исполнения, расхождение «исполнено» в сигналах с суммой сделок, остановки (halt).
 */
export function checkSignals(
  signals: readonly AutomatSignal[],
  fills: readonly Yv1Fill[],
  logDays: readonly AutomatLogDay[],
): Discrepancy[] {
  const out: Discrepancy[] = [];
  const mine = fills.filter((f) => f.allocation === 'yv1' && f.side !== null);
  for (const s of signals) {
    if (s.dryRun) continue;
    for (const [name, h] of [['h1', s.h1], ['h2', s.h2]] as const) {
      if (h.signal === 0 && h.planned === 0) continue;
      const signed = mine
        .filter((f) => f.date === s.date && f.reason === name)
        .reduce((acc, f) => acc.plus(f.side === 'B' ? f.qty : new Decimal(f.qty).neg()), new Decimal(0));
      // «исполнено» в сигналах ещё может быть не дописано — тогда ориентируемся на сами сделки
      const filled = h.filled === null ? signed.toNumber() : h.filled;
      if (h.planned > 0 && filled === 0 && signed.isZero()) {
        out.push({
          kind: 'missed-half',
          severity: 'error',
          date: s.date,
          tradeNum: null,
          message: `${s.date}: половина ${name} должна была войти (сигнал ${h.signal}, ${h.planned} контр.), сделок нет${h.skip ? ` (причина: ${h.skip})` : ''}`,
        });
        continue;
      }
      if (h.planned > 0 && Math.abs(filled) < h.planned) {
        out.push({
          kind: 'partial-fill',
          severity: 'warn',
          date: s.date,
          tradeNum: null,
          message: `${s.date}: половина ${name} исполнена частично — ${Math.abs(filled)} из ${h.planned} контр.`,
        });
      }
      if (h.filled !== null && !signed.eq(h.filled)) {
        out.push({
          kind: 'signal-fill-mismatch',
          severity: 'warn',
          date: s.date,
          tradeNum: null,
          message: `${s.date}: в сигналах ${name} исполнено ${h.filled}, по сделкам ${signed.toFixed()}`,
        });
      }
    }
  }
  for (const d of logDays) {
    if (d.haltLines.length > 0) {
      out.push({
        kind: 'halt',
        severity: 'error',
        date: d.date,
        tradeNum: null,
        message: `${d.date}: автомат остановил торговлю (halt): ${d.haltLines[0]}`,
      });
    }
  }
  return out;
}

/**
 * Позиция в снимке против сделок того же снимка: startnet + Σ сделок дня = totalnet.
 * Ловит потерянные сделки (таблица trades не догрузилась) и неверное направление.
 */
export function checkSnapshotPosition(
  snapId: string,
  trades: readonly QsnapTrade[],
  holdings: readonly QsnapHolding[],
): Discrepancy[] {
  const out: Discrepancy[] = [];
  for (const h of holdings) {
    if (!isCrContract(h.secCode)) continue;
    const mine = trades.filter((t) => t.secCode === h.secCode && t.account === h.account);
    if (mine.some((t) => t.side === null)) continue; // направление неизвестно — проверить нельзя
    const delta = mine.reduce(
      (acc, t) => acc.plus(t.side === 'B' ? t.qty : new Decimal(t.qty).neg()),
      new Decimal(0),
    );
    const expected = new Decimal(h.startNet).plus(delta);
    if (!expected.eq(h.totalNet)) {
      out.push({
        kind: 'position-mismatch',
        severity: 'error',
        date: null,
        tradeNum: null,
        message: `Снимок ${snapId}, ${h.secCode}: позиция на начало ${h.startNet} + сделки ${delta.toFixed()} = ${expected.toFixed()}, а в таблице ${h.totalNet}`,
      });
    }
  }
  return out;
}

export interface MoneyIdentityComponent {
  group: 'yv1' | 'other-strategy' | 'unallocated' | 'fund' | 'vm-posted';
  label: string;
  amountRub: string;
}

export interface MoneyIdentity {
  snapId: string;
  tradeDate: string;
  /** false — тест нельзя посчитать (нет денег в снимке или неизвестно направление сделки фонда) */
  applicable: boolean;
  note: string | null;
  /** рубли Т1: на начало дня и сейчас */
  t1Open: string | null;
  t1Current: string | null;
  delta: string | null;
  components: MoneyIdentityComponent[];
  explained: string | null;
  residual: string | null;
  ok: boolean | null;
}

/** Допуск теста полноты: копейка */
export const MONEY_IDENTITY_TOLERANCE = '0.01';

/**
 * Тест полноты: изменение рублей Т1 внутри дня = сумма по ТС + «не распределено» + фонд +
 * проведённая ВМ. Из текущего устройства QUIK следует:
 *  - в рублях Т1 стоят брокерские комиссии по ОЦЕНКЕ QUIK (завышенной; биржа и клиринг
 *    в неё уже входят), а не по факту — поэтому компоненты берутся из broker_comission;
 *  - ВМ до клиринга в рубли не попадает (real_varmargin = 0), поэтому вклад ВМ — только
 *    проведённая часть;
 *  - сделки фонда (SBMM) меняют рубли на сумму сделки.
 * Невязка ≠ 0 значит либо пополнение/вывод, либо потерянная сделка, либо изменение
 * правил QUIK — в любом случае её нужно разобрать руками, а не сглаживать.
 */
export function moneyIdentity(input: {
  snapId: string;
  tradeDate: string;
  trades: readonly QsnapTrade[];
  automatTradeNums: ReadonlySet<string>;
  /** сделки журналов других стратегий на счёте — отдельная группа, не «не распределено» */
  otherStrategyTradeNums?: ReadonlySet<string>;
  money: QsnapMoney | null;
  holdings: readonly QsnapHolding[];
}): MoneyIdentity {
  const base: MoneyIdentity = {
    snapId: input.snapId,
    tradeDate: input.tradeDate,
    applicable: false,
    note: null,
    t1Open: null,
    t1Current: null,
    delta: null,
    components: [],
    explained: null,
    residual: null,
    ok: null,
  };
  if (!input.money) return { ...base, note: 'в снимке нет денежных лимитов (money_limits)' };
  if (input.money.ambiguous) {
    return { ...base, note: 'несколько клиентских кодов с рублями Т0 — тест неоднозначен' };
  }
  const isFutures = (t: QsnapTrade): boolean => isCrContract(t.secCode) || t.classCode === 'SPBFUT';
  if (input.trades.some((t) => !isFutures(t) && t.side === null)) {
    return { ...base, note: 'у сделки фонда не определено направление — сумму сделки со знаком не посчитать' };
  }

  const sumFee = (ts: readonly QsnapTrade[]): Decimal => ts.reduce((a, t) => a.plus(t.brokerFeeQuik), new Decimal(0));
  // фьючерсы (в том числе не CR*) денег на сумму сделки не двигают — только комиссия; остальное — фонд
  const cr = input.trades.filter(isFutures);
  const yv1 = cr.filter((t) => input.automatTradeNums.has(t.tradeNum));
  const isOther = (t: QsnapTrade): boolean => input.otherStrategyTradeNums?.has(t.tradeNum) ?? false;
  const otherStrategy = cr.filter((t) => !input.automatTradeNums.has(t.tradeNum) && isOther(t));
  const unallocated = cr.filter((t) => !input.automatTradeNums.has(t.tradeNum) && !isOther(t));
  const fund = input.trades.filter((t) => !isFutures(t));

  const fundCash = fund.reduce(
    (a, t) => a.plus(new Decimal(t.value).mul(t.side === 'B' ? -1 : 1)).minus(t.brokerFeeQuik),
    new Decimal(0),
  );
  const vmPosted = input.holdings
    .filter((h) => isCrContract(h.secCode))
    .reduce((a, h) => a.plus(h.realVarMargin), new Decimal(0));

  const components: MoneyIdentityComponent[] = [
    { group: 'yv1', label: 'комиссии QUIK по сделкам ТС', amountRub: sumFee(yv1).neg().toFixed(2) },
    // группа появляется только при наличии сделок соседней стратегии: у одной стратегии вывод прежний
    ...(otherStrategy.length > 0
      ? [{ group: 'other-strategy' as const, label: 'комиссии QUIK по сделкам других стратегий', amountRub: sumFee(otherStrategy).neg().toFixed(2) }]
      : []),
    { group: 'unallocated', label: 'комиссии QUIK по не распределённым сделкам CR*', amountRub: sumFee(unallocated).neg().toFixed(2) },
    { group: 'fund', label: 'сделки фонда (сумма и комиссия)', amountRub: fundCash.toFixed(2) },
    { group: 'vm-posted', label: 'проведённая вариационная маржа', amountRub: vmPosted.toFixed(2) },
  ];
  const explained = components.reduce((a, c) => a.plus(c.amountRub), new Decimal(0));
  const delta = new Decimal(input.money.t1Current).minus(input.money.t1Open);
  const residual = delta.minus(explained);
  return {
    ...base,
    applicable: true,
    t1Open: input.money.t1Open,
    t1Current: input.money.t1Current,
    delta: delta.toFixed(2),
    components,
    explained: explained.toFixed(2),
    residual: residual.toFixed(2),
    ok: residual.abs().lte(MONEY_IDENTITY_TOLERANCE),
  };
}

export interface CalcTradesCheck {
  rows: number;
  /** максимум |model − calc_trades.broker_fee| среди CR-сделок, ₽ */
  maxBrokerDiff: string;
  discrepancies: Discrepancy[];
}

/**
 * Калибровка `calc_trades` скрипта: брокерская часть против нашей модели (0.015 % с
 * округлением вверх), биржа+клиринг против полей сделки, «оценка QUIK» против сделки.
 * Копеечные расхождения — следствие разного округления и допускаются (≤ 0.01 ₽).
 */
export function checkCalcTrades(
  calc: readonly QsnapCalcTrade[],
  trades: readonly QsnapTrade[],
  rounding: FeeRounding = DEFAULT_FEE_ROUNDING,
): CalcTradesCheck {
  const byNum = new Map(trades.map((t) => [t.tradeNum, t]));
  const discrepancies: Discrepancy[] = [];
  let maxDiff = new Decimal(0);
  const tol = new Decimal('0.01');
  for (const c of calc) {
    const t = byNum.get(c.tradeNum);
    if (!t) {
      discrepancies.push({ kind: 'calc-trades-diff', severity: 'warn', date: null, tradeNum: c.tradeNum, message: `calc_trades: сделки ${c.tradeNum} нет в trades того же снимка` });
      continue;
    }
    if (isCrContract(c.secCode)) {
      const model = new Decimal(modelBrokerFee(t.value, rounding));
      const diff = model.minus(c.brokerFee).abs();
      if (diff.gt(maxDiff)) maxDiff = diff;
      if (diff.gt(tol)) {
        discrepancies.push({ kind: 'calc-trades-diff', severity: 'warn', date: t.date, tradeNum: c.tradeNum, message: `calc_trades: брокер ${c.brokerFee} против модели ${model.toFixed(2)} (сумма ${t.value})` });
      }
    }
    const ts = new Decimal(t.exchangeFee).plus(t.clearingFee).plus(t.techCenterFee);
    if (ts.minus(c.tsFee).abs().gt(tol)) {
      discrepancies.push({ kind: 'calc-trades-diff', severity: 'warn', date: t.date, tradeNum: c.tradeNum, message: `calc_trades: биржа+клиринг ${c.tsFee} против полей сделки ${ts.toFixed(2)}` });
    }
    if (new Decimal(t.brokerFeeQuik).minus(c.quikBrokerComission).abs().gt(tol)) {
      discrepancies.push({ kind: 'calc-trades-diff', severity: 'warn', date: t.date, tradeNum: c.tradeNum, message: `calc_trades: оценка QUIK ${c.quikBrokerComission} против сделки ${t.brokerFeeQuik}` });
    }
  }
  return { rows: calc.length, maxBrokerDiff: maxDiff.toFixed(2), discrepancies };
}
