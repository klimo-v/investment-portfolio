/**
 * Метрики эффективности портфеля/системы (docs/05-review-usability.md §1).
 * Чистые функции без побочных эффектов — легко тестируются на реальных цифрах
 * (CLAUDE.md §7 SRP, §10 тесты финансовой логики). Отделены от движка позиций
 * (engine.ts): движок отвечает «что и сколько», метрики — «насколько эффективно».
 */

/** Денежный поток для XIRR: дата (YYYY-MM-DD) и сумма (− вложение, + возврат) */
export interface CashFlow {
  date: string;
  amount: number;
}

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

function toTime(date: string): number {
  return new Date(`${date}T00:00:00Z`).getTime();
}

/**
 * XIRR — внутренняя норма доходности с учётом дат и неравномерных вложений
 * (денежно-взвешенная годовая доходность). Возвращает долю (0.184 = +18.4% годовых)
 * или null, если решение не определено (нет и притока, и оттока — доходность
 * посчитать не от чего).
 *
 * Знак потоков: покупка/ввод денег — отрицательный (капитал ушёл в позицию),
 * продажа/дивиденд/итоговая стоимость остатка — положительный. Ньютон с откатом
 * на бисекцию — надёжнее чистого Ньютона при «плохом» стартовом приближении.
 */
export function xirr(flows: CashFlow[], guess = 0.1): number | null {
  if (flows.length < 2) return null;
  if (!flows.some((f) => f.amount > 0) || !flows.some((f) => f.amount < 0)) return null;

  const t0 = Math.min(...flows.map((f) => toTime(f.date)));
  const years = (date: string): number => (toTime(date) - t0) / MS_PER_YEAR;

  const npv = (rate: number): number =>
    flows.reduce((sum, f) => sum + f.amount / Math.pow(1 + rate, years(f.date)), 0);
  const dNpv = (rate: number): number =>
    flows.reduce((sum, f) => {
      const y = years(f.date);
      return sum - (y * f.amount) / Math.pow(1 + rate, y + 1);
    }, 0);

  // Ньютон-Рафсон
  let rate = guess;
  for (let i = 0; i < 100; i++) {
    const value = npv(rate);
    const deriv = dNpv(rate);
    if (!Number.isFinite(value) || !Number.isFinite(deriv) || deriv === 0) break;
    const next = rate - value / deriv;
    if (!Number.isFinite(next) || next <= -0.9999) break;
    if (Math.abs(next - rate) < 1e-8) return next;
    rate = next;
  }

  // Бисекция на [-99.99%, +1000%] — если на концах разные знаки NPV
  let lo = -0.9999;
  let hi = 10;
  let fLo = npv(lo);
  const fHi = npv(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-7) return mid;
    if (fLo * fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Максимальная просадка по ряду стоимости — наибольшее относительное падение от
 * достигнутого пика до последующего дна. Возвращает долю ≤ 0 (−0.123 = −12.3%).
 * Нужна для оценки риска: доходность без просадки — половина картины (§1.5 ревью).
 */
export function maxDrawdown(series: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const value of series) {
    if (value > peak) peak = value;
    if (peak > 0) {
      const drawdown = (value - peak) / peak;
      if (drawdown < worst) worst = drawdown;
    }
  }
  return worst;
}

/** Вход для статистики сделок — минимум полей от Trade/TradeResult */
export interface TradeStatInput {
  status: 'Open' | 'Partial' | 'Closed';
  realizedPnlRub: number;
  openedAt: string;
  closedAt: string | null;
}

/** Агрегированная статистика по закрытым сделкам системы/портфеля (§1.3 ревью) */
export interface TradeStats {
  closedCount: number;
  winCount: number;
  lossCount: number;
  /** доля прибыльных сделок, 0..100 */
  winRatePct: number;
  /** сумма прибылей / сумма убытков; null — если убытков не было */
  profitFactor: number | null;
  /** средняя прибыль по прибыльной сделке (≥ 0) */
  avgWinRub: number;
  /** средний убыток по убыточной сделке (≤ 0) */
  avgLossRub: number;
  /** средний реализованный результат на закрытую сделку (матожидание) */
  expectancyRub: number;
  /** средний срок удержания закрытой сделки в днях */
  avgHoldingDays: number;
}

/**
 * Статистика эффективности стратегии по ЗАКРЫТЫМ сделкам: win rate, profit factor,
 * средний выигрыш/убыток, матожидание, срок удержания. Открытые/частичные сделки
 * не берём — их результат ещё не зафиксирован.
 */
export function tradeStats(trades: TradeStatInput[]): TradeStats {
  const closed = trades.filter((t) => t.status === 'Closed');
  const closedCount = closed.length;

  let grossProfit = 0;
  let grossLoss = 0; // положительная величина суммарного убытка
  let winCount = 0;
  let lossCount = 0;
  let holdingDaysSum = 0;

  for (const t of closed) {
    const pnl = t.realizedPnlRub;
    if (pnl > 0) {
      grossProfit += pnl;
      winCount++;
    } else if (pnl < 0) {
      grossLoss += -pnl;
      lossCount++;
    }
    if (t.closedAt) {
      const days = (toTime(t.closedAt) - toTime(t.openedAt)) / (24 * 60 * 60 * 1000);
      holdingDaysSum += Math.max(0, days);
    }
  }

  return {
    closedCount,
    winCount,
    lossCount,
    winRatePct: closedCount > 0 ? (winCount / closedCount) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    avgWinRub: winCount > 0 ? grossProfit / winCount : 0,
    avgLossRub: lossCount > 0 ? -grossLoss / lossCount : 0,
    expectancyRub: closedCount > 0 ? (grossProfit - grossLoss) / closedCount : 0,
    avgHoldingDays: closedCount > 0 ? holdingDaysSum / closedCount : 0,
  };
}
