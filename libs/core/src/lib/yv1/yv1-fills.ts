import Decimal from 'decimal.js';
import type { AutomatTrade } from './yv1-automat';
import type { QsnapTrade, Side } from './qsnap-extract';
import {
  CONTRACT_MULTIPLIER,
  RECONCILE_TOLERANCE,
  isCrContract,
  type Discrepancy,
} from './yv1-types';

Decimal.set({ precision: 40 });

/** Сделка из конкретного целого снимка */
export interface SnapshotTrade extends QsnapTrade {
  snapId: string;
}

/** Принадлежность сделки: в журнале автомата — ТС, остальное по CR* — «не распределено» */
export type Allocation = 'yv1' | 'unallocated';

export interface Yv1Fill {
  tradeNum: string;
  orderNum: string | null;
  /** биржевое время, МСК */
  date: string;
  time: string;
  contract: string;
  side: Side | null;
  sideSource: 'automat' | 'order-flags' | 'unknown';
  qty: string;
  price: string;
  /** сумма сделки, ₽ */
  value: string;
  /** оценка QUIK — завышена, в расчёт net не идёт */
  brokerFeeQuik: string | null;
  exchangeFee: string | null;
  clearingFee: string | null;
  techCenterFee: string | null;
  /** exit | h1 | h2 | иное из журнала автомата; null у не распределённых */
  reason: string | null;
  refPrice: string | null;
  slipRubAutomat: string | null;
  inBridge: boolean;
  inAutomat: boolean;
  /** снимок, из которого взята сделка (последний целый, где она есть) */
  snapId: string | null;
  allocation: Allocation;
  /** у не распределённых: время похоже на вход/выход автомата (10:20, 13:00, 15:00) */
  looksLikeSystem: boolean;
}

export interface FillsResult {
  fills: Yv1Fill[];
  /** сделки не по CR* (фонд и т.п.), по последнему снимку */
  otherTrades: SnapshotTrade[];
  /**
   * сделки по счёту из журнала ДРУГОЙ стратегии: не наши и не «не распределено». Не попадают
   * ни в циклы, ни в расхождения, но учитываются в тесте полноты денег отдельной группой.
   */
  otherStrategyTrades: SnapshotTrade[];
  discrepancies: Discrepancy[];
}

const toSec = (t: string): number => {
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
};

const SYSTEM_MOMENTS = [10 * 3600 + 20 * 60, 13 * 3600, 15 * 3600];
const looksLikeSystemTime = (time: string): boolean =>
  SYSTEM_MOMENTS.some((m) => Math.abs(toSec(time) - m) <= 90);

function sameTrade(a: QsnapTrade, b: QsnapTrade): boolean {
  return (
    a.secCode === b.secCode &&
    a.date === b.date &&
    a.time === b.time &&
    new Decimal(a.price).eq(b.price) &&
    new Decimal(a.qty).eq(b.qty)
  );
}

/**
 * Сводит сделки моста и журнала автомата в единый список.
 *  - Один trade_num повторяется в каждом снимке: берём последний целый снимок, но
 *    сверяем со всеми остальными — расхождение между снимками отдельный пункт.
 *  - Приоритет значений: мост (время с миллисекундами, цена, количество, комиссии) →
 *    журнал автомата (причина входа, ref_price, сторона).
 *  - «Только в автомате» отмечаем лишь для дат, где есть целый снимок на ту же торговую
 *    дату (`verifiableDates`): таблица сделок QUIK хранит только текущую сессию, и
 *    отсутствие сделки в снимке другого дня ничего не доказывает.
 */
export function buildFills(input: {
  qsnapTrades: readonly SnapshotTrade[];
  automatTrades: readonly AutomatTrade[];
  verifiableDates: ReadonlySet<string>;
  /** дата → local_time последнего целого снимка; позже этого момента отсутствие сделки в мосте не ошибка */
  verifiableUntil?: ReadonlyMap<string, string>;
  /** номера сделок из журналов других стратегий на том же счёте */
  otherStrategyTradeNums?: ReadonlySet<string>;
}): FillsResult {
  const discrepancies: Discrepancy[] = [];

  // 1) дедуп по trade_num между снимками: сортировка по snap_id (время запуска) → последний выигрывает
  const bridge = new Map<string, SnapshotTrade>();
  for (const t of [...input.qsnapTrades].sort((a, b) => a.snapId.localeCompare(b.snapId))) {
    const prev = bridge.get(t.tradeNum);
    if (prev && !sameTrade(prev, t)) {
      discrepancies.push({
        kind: 'snapshot-conflict',
        severity: 'error',
        date: t.date,
        tradeNum: t.tradeNum,
        message: `Сделка ${t.tradeNum} в снимках ${prev.snapId} и ${t.snapId} описана по-разному (цена, количество или время)`,
      });
    }
    bridge.set(t.tradeNum, t);
  }

  // 2) журнал автомата: тот же trade_num в двух файлах — дубль, первый выигрывает
  const automat = new Map<string, AutomatTrade>();
  for (const a of input.automatTrades) {
    const prev = automat.get(a.tradeNum);
    if (prev) {
      if (prev.price !== a.price || prev.qty !== a.qty) {
        discrepancies.push({
          kind: 'automat-duplicate',
          severity: 'warn',
          date: a.date,
          tradeNum: a.tradeNum,
          message: `Сделка ${a.tradeNum} в журналах автомата ${prev.sourceFile} и ${a.sourceFile} записана по-разному`,
        });
      }
      continue;
    }
    automat.set(a.tradeNum, a);
  }

  const fills: Yv1Fill[] = [];
  const otherTrades: SnapshotTrade[] = [];
  const otherStrategyTrades: SnapshotTrade[] = [];

  const nums = new Set<string>([...bridge.keys(), ...automat.keys()]);
  for (const num of [...nums].sort()) {
    const q = bridge.get(num);
    const a = automat.get(num);

    if (q && !isCrContract(q.secCode) && !a) {
      otherTrades.push(q);
      continue;
    }
    // сделка соседней стратегии: ни наша, ни «не распределено» — без ложного manual-trade
    if (q && !a && input.otherStrategyTradeNums?.has(num)) {
      otherStrategyTrades.push(q);
      continue;
    }

    if (q && a) discrepancies.push(...compareTrade(q, a));
    const until = input.verifiableUntil?.get(a?.date ?? '');
    if (a && !q && input.verifiableDates.has(a.date) && (until === undefined || until >= `${a.date} ${a.time}`)) {
      discrepancies.push({
        kind: 'only-in-automat',
        severity: 'warn',
        date: a.date,
        tradeNum: num,
        message: `Сделка ${num} есть в журнале автомата, но её нет в целом снимке моста за ${a.date}`,
      });
    }

    const contract = q?.secCode ?? a?.contract ?? '';
    const time = q ? q.time : (a?.time ?? '');
    const side: Side | null = a?.side ?? q?.side ?? null;
    const sideSource: Yv1Fill['sideSource'] = a ? 'automat' : q?.side ? 'order-flags' : 'unknown';
    const qty = q?.qty ?? a?.qty ?? '0';
    const price = q?.price ?? a?.price ?? '0';
    const unallocated = !a;

    if (unallocated) {
      discrepancies.push({
        kind: 'manual-trade',
        severity: 'warn',
        date: q?.date ?? null,
        tradeNum: num,
        message:
          `Сделка ${num} по ${contract} в ${q?.date} ${q?.time} не из журнала автомата — «не распределено»` +
          (looksLikeSystemTime(time) ? ' (время похоже на вход/выход системы)' : ''),
      });
    }
    if (side === null) {
      discrepancies.push({
        kind: 'side-unknown',
        severity: 'warn',
        date: q?.date ?? a?.date ?? null,
        tradeNum: num,
        message: `Не удалось определить направление сделки ${num}: в снимке нет её заявки и сделки нет в журнале автомата`,
      });
    }

    fills.push({
      tradeNum: num,
      orderNum: q?.orderNum ?? a?.orderNum ?? null,
      date: q?.date ?? a?.date ?? '',
      time: q ? `${q.time}.${q.ms}` : time,
      contract,
      side,
      sideSource,
      qty,
      price,
      value: q?.value ?? new Decimal(qty).mul(price).mul(CONTRACT_MULTIPLIER).toFixed(),
      brokerFeeQuik: q ? q.brokerFeeQuik : (a?.brokerFeeQuik ?? null),
      exchangeFee: q ? q.exchangeFee : (a?.exchangeFee ?? null),
      clearingFee: q ? q.clearingFee : (a?.clearingFee ?? null),
      techCenterFee: q ? q.techCenterFee : (a?.techCenterFee ?? null),
      reason: a?.reason ?? null,
      refPrice: a?.refPrice ?? null,
      slipRubAutomat: a?.slipRub ?? null,
      inBridge: !!q,
      inAutomat: !!a,
      snapId: q?.snapId ?? null,
      allocation: unallocated ? 'unallocated' : 'yv1',
      looksLikeSystem: unallocated && looksLikeSystemTime(time),
    });
  }

  fills.sort((x, y) => `${x.date} ${x.time}`.localeCompare(`${y.date} ${y.time}`) || x.tradeNum.localeCompare(y.tradeNum));
  return { fills, otherTrades, otherStrategyTrades, discrepancies };
}

/** Сверка одной сделки в двух источниках по допускам RECONCILE_TOLERANCE */
export function compareTrade(q: SnapshotTrade, a: AutomatTrade): Discrepancy[] {
  const out: Discrepancy[] = [];
  const base = { date: q.date, tradeNum: q.tradeNum, severity: 'error' as const };
  if (q.secCode !== a.contract) {
    out.push({ ...base, kind: 'mismatch-contract', message: `Сделка ${q.tradeNum}: контракт ${q.secCode} в мосте, ${a.contract} в автомате` });
  }
  if (q.date !== a.date) {
    out.push({ ...base, kind: 'mismatch-date', message: `Сделка ${q.tradeNum}: дата ${q.date} в мосте, ${a.date} в автомате` });
  } else if (Math.abs(toSec(q.time) - toSec(a.time)) > RECONCILE_TOLERANCE.timeSec) {
    out.push({ ...base, kind: 'mismatch-time', message: `Сделка ${q.tradeNum}: время ${q.time} в мосте, ${a.time} в автомате (допуск ${RECONCILE_TOLERANCE.timeSec} с)` });
  }
  if (new Decimal(q.price).minus(a.price).abs().gt(RECONCILE_TOLERANCE.priceAbs)) {
    out.push({ ...base, kind: 'mismatch-price', message: `Сделка ${q.tradeNum}: цена ${q.price} в мосте, ${a.price} в автомате` });
  }
  if (new Decimal(q.qty).minus(a.qty).abs().gt(RECONCILE_TOLERANCE.qtyAbs)) {
    out.push({ ...base, kind: 'mismatch-qty', message: `Сделка ${q.tradeNum}: количество ${q.qty} в мосте, ${a.qty} в автомате` });
  }
  if (q.side && q.side !== a.side) {
    out.push({ ...base, kind: 'mismatch-side', message: `Сделка ${q.tradeNum}: сторона ${q.side} по флагам заявки, ${a.side} в автомате — проверить разбор флагов` });
  }
  const fees: [string, string, string | null][] = [
    ['брокерская оценка QUIK', q.brokerFeeQuik, a.brokerFeeQuik],
    ['биржевая', q.exchangeFee, a.exchangeFee],
    ['клиринговая', q.clearingFee, a.clearingFee],
  ];
  for (const [name, qv, av] of fees) {
    if (av !== null && new Decimal(qv).minus(av).abs().gt(RECONCILE_TOLERANCE.feeAbs)) {
      out.push({ ...base, severity: 'warn', kind: 'mismatch-fee', message: `Сделка ${q.tradeNum}: ${name} комиссия ${qv} в мосте, ${av} в автомате` });
    }
  }
  return out;
}
