import Decimal from 'decimal.js';

/**
 * Лента результата стратегии: реализованный net по дням. Это единый «контракт» между
 * адаптерами стратегий и портфелем: адаптер приводит свои циклы/сделки к этому виду, а
 * агрегатор портфеля складывает ленты, ничего не зная про формат источника.
 *
 * Дата результата — дата закрытия цикла (когда деньги реально зафиксированы). Открытые
 * и частично закрытые циклы в ленту не попадают: их результат ещё не окончателен.
 */

/** Минимум полей цикла, нужный ленте (структурно совместим с Yv1Cycle / Yv1CycleView) */
export interface ClosableCycle {
  status: 'open' | 'partial' | 'closed';
  closeDate: string | null;
  pnlPrice: string;
  costs: { total: string };
  debtInterest: string;
  netRub: string;
}

export interface StrategyDailyResult {
  /** дата закрытия циклов, YYYY-MM-DD */
  date: string;
  /** результат по ценам сделок, ₽ */
  pricePnlRub: string;
  /** издержки (брокер + биржа + клиринг), ₽ */
  costsRub: string;
  /** проценты по долгу, ₽ */
  debtInterestRub: string;
  /** pricePnl − costs − debtInterest, ₽ */
  netRub: string;
  /** сколько циклов закрылось в этот день */
  cycles: number;
}

/** Закрытые циклы → результат по дням, по возрастанию даты. Деньги — Decimal, без float */
export function cyclesToDailyResults(cycles: readonly ClosableCycle[]): StrategyDailyResult[] {
  const byDate = new Map<string, { price: Decimal; costs: Decimal; debt: Decimal; net: Decimal; n: number }>();
  for (const c of cycles) {
    if (c.status !== 'closed' || c.closeDate === null) continue;
    const acc = byDate.get(c.closeDate) ?? {
      price: new Decimal(0),
      costs: new Decimal(0),
      debt: new Decimal(0),
      net: new Decimal(0),
      n: 0,
    };
    acc.price = acc.price.plus(c.pnlPrice);
    acc.costs = acc.costs.plus(c.costs.total);
    acc.debt = acc.debt.plus(c.debtInterest);
    acc.net = acc.net.plus(c.netRub);
    acc.n += 1;
    byDate.set(c.closeDate, acc);
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({
      date,
      pricePnlRub: v.price.toFixed(2),
      costsRub: v.costs.toFixed(2),
      debtInterestRub: v.debt.toFixed(2),
      netRub: v.net.toFixed(2),
      cycles: v.n,
    }));
}
