import { describe, expect, it } from 'vitest';
import type { Operation } from './schemas';
import { calculatePositions, calculateTrades, realizedPnlInRange } from './engine';
import { cashBalanceRub, cashDelta, dailyCash, orphanSellsRub } from './cash';
import { periodPerformance, payoutsInPeriod } from './period-performance';
import { cashSeries, valuationEvents } from './valuation-extras';
import { valuationSeries, type PriceObservation } from './valuation';

const mk = (o: Partial<Operation> & Pick<Operation, 'date' | 'operationType'>): Operation =>
  ({ portfolioId: 'p1', systemId: 's1', quantity: '1', price: '0', fee: '0', fxRate: '1', currency: 'RUB', ...o }) as Operation;

const px = (instrumentId: string, date: string, price: string): PriceObservation => ({
  instrumentId, date, price, currency: 'RUB', accruedInterest: null, accruedCurrency: null,
});

const FUT = new Set(['CNY-12.26']);

/** Журнал со всем, что двигает деньги: ввод/вывод, покупки с комиссией, частичные продажи, выплаты, налоги, комиссии, фьючерс */
const OPS: Operation[] = [
  mk({ date: '2026-01-05', operationType: 'Deposit', price: '1000000' }),
  mk({ date: '2026-01-06', operationType: 'Buy', instrumentId: 'SBER', quantity: '100', price: '100', fee: '15' }),
  mk({ date: '2026-01-07', operationType: 'Buy', instrumentId: 'GAZP', quantity: '50', price: '200', fee: '7.5', systemId: 's2' }),
  mk({ date: '2026-02-10', operationType: 'Sell', instrumentId: 'SBER', quantity: '40', price: '130', fee: '5' }),
  mk({ date: '2026-03-01', operationType: 'Dividend', instrumentId: 'SBER', quantity: '1', price: '300' }),
  mk({ date: '2026-03-02', operationType: 'Tax', instrumentId: 'SBER', quantity: '1', price: '39' }), // налог с дивиденда
  mk({ date: '2026-03-15', operationType: 'Deposit', price: '500000', systemId: 's2' }),
  // перевод денег с другого счёта (входящий — плюс): внешний поток, как ввод
  mk({ date: '2026-03-16', operationType: 'Transfer', quantity: '1', price: '2500' }),
  mk({ date: '2026-03-17', operationType: 'Transfer', quantity: '1', price: '-700', systemId: 's2' }),
  mk({ date: '2026-04-01', operationType: 'Coupon', quantity: '1', price: '777' }), // без инструмента
  mk({ date: '2026-04-02', operationType: 'Tax', quantity: '1', price: '101' }), // налог без инструмента
  mk({ date: '2026-04-05', operationType: 'Fee', quantity: '1', price: '25' }), // комиссия депозитария
  mk({ date: '2026-04-20', operationType: 'Withdraw', price: '200000' }),
  mk({ date: '2026-05-10', operationType: 'Sell', instrumentId: 'GAZP', quantity: '50', price: '190', systemId: 's2' }),
  mk({ date: '2026-06-01', operationType: 'Buy', instrumentId: 'SBER', quantity: '10', price: '125' }),
  // фьючерс: комиссия внутри результата, отдельные Fee по нему в кэш не добавляются
  mk({ date: '2026-03-05', operationType: 'Buy', instrumentId: 'CNY-12.26', quantity: '2', price: '12000', fee: '10', portfolioId: 'p2' }),
  mk({ date: '2026-03-23', operationType: 'Sell', instrumentId: 'CNY-12.26', quantity: '2', price: '12200', fee: '15', portfolioId: 'p2' }),
  mk({ date: '2026-03-24', operationType: 'Fee', instrumentId: 'CNY-12.26', quantity: '1', price: '3', portfolioId: 'p2' }),
];

const PRICES: PriceObservation[] = [
  px('SBER', '2026-01-06', '100'), px('SBER', '2026-02-10', '130'), px('SBER', '2026-06-15', '150'),
  px('GAZP', '2026-01-07', '200'), px('GAZP', '2026-05-10', '190'),
];

const series = (groupBy: 'portfolio' | 'system' | 'instrument', till = '2026-06-30') =>
  valuationSeries(OPS, PRICES, { till, groupBy, futureIds: FUT });

describe('cashSeries: кэш из ряда = кэш из журнала', () => {
  it.each(['portfolio', 'system', 'instrument'] as const)('на сегодня совпадает с cashBalanceRub (%s) — до копейки', (groupBy) => {
    const cash = cashSeries(series(groupBy), OPS, { futureIds: FUT });
    expect(cash[cash.length - 1]).toBe(cashBalanceRub(OPS, FUT).toFixed(2));
  });

  it('совпадает на любую дату, а не только на последнюю', () => {
    for (const till of ['2026-01-10', '2026-03-02', '2026-04-10', '2026-05-20']) {
      const cash = cashSeries(series('instrument', till), OPS, { futureIds: FUT });
      const upTo = OPS.filter((o) => o.date <= till);
      expect(cash[cash.length - 1], till).toBe(cashBalanceRub(upTo, FUT).toFixed(2));
    }
  });

  it('продажа переливает стоимость в кэш: богатство (позиции + кэш) в день продажи не падает', () => {
    // цена GAZP уже 190 накануне, поэтому в день продажи по 190 рыночного движения нет
    const s = valuationSeries(OPS, [...PRICES, px('GAZP', '2026-05-09', '190')], { till: '2026-06-30', groupBy: 'instrument', futureIds: FUT });
    const cash = cashSeries(s, OPS, { futureIds: FUT });
    const i = s.groups[0].points.findIndex((p) => p.date === '2026-05-10'); // продажа всех GAZP
    const positions = (k: number) => s.groups.reduce((sum, g) => sum + Number(g.points[k].marketValueRub), 0);
    expect(positions(i)).toBeLessThan(positions(i - 1) - 9000); // 50 × 190 = 9 500 // стоимость позиций упала на проданное
    const wealth = (k: number) => positions(k) + Number(cash[k]);
    expect(wealth(i) - wealth(i - 1)).toBeCloseTo(0, 0); // богатство — нет
  });

  it('налоги и отдельные комиссии уменьшают итог, комиссия по фьючерсу — не дублируется', () => {
    const withCosts = series('portfolio');
    const without = valuationSeries(
      OPS.filter((o) => o.operationType !== 'Tax' && !(o.operationType === 'Fee' && !o.instrumentId)),
      PRICES,
      { till: '2026-06-30', groupBy: 'portfolio', futureIds: FUT },
    );
    const last = (s: typeof withCosts) => Number(s.groups.reduce((sum, g) => sum + Number(g.points[g.points.length - 1].totalRub), 0));
    // налоги 39 + 101 и комиссия 25; Fee по фьючерсу (3) в итог не идёт
    expect(last(without) - last(withCosts)).toBeCloseTo(39 + 101 + 25, 6);
  });

  it('возврат налога (Tax с отрицательной суммой) увеличивает итог ряда, кэш ряда = кэш журнала', () => {
    const refund = mk({ date: '2026-04-03', operationType: 'Tax', quantity: '1', price: '-101' });
    const ops = [...OPS, refund];
    const s = valuationSeries(ops, PRICES, { till: '2026-06-30', groupBy: 'portfolio', futureIds: FUT });
    const base = series('portfolio');
    const last = (x: typeof s) => x.groups.reduce((sum, g) => sum + Number(g.points[g.points.length - 1].totalRub), 0);
    expect(last(s) - last(base)).toBeCloseTo(101, 6);
    expect(cashSeries(s, ops, { futureIds: FUT }).at(-1)).toBe(cashBalanceRub(ops, FUT).toFixed(2));
  });

  it('инвариант: чистый ввод + итог − стоимость = кэш − продажи без позиции (на каждый день)', () => {
    // продажа CNYRUB без покупки: деньги пришли, позиции нет
    const ops = [
      ...OPS,
      mk({ date: '2026-02-01', operationType: 'Sell', instrumentId: 'CNYRUB', quantity: '1000', price: '12', fee: '5' }),
    ];
    const s = valuationSeries(ops, PRICES, { till: '2026-06-30', groupBy: 'portfolio', futureIds: FUT });
    const cash = cashSeries(s, ops, { futureIds: FUT });
    const daily = dailyCash(ops, FUT);
    s.groups[0].points.forEach((p, i) => {
      const result = s.groups.reduce((sum, g) => sum + Number(g.points[i].totalRub), 0);
      const market = s.groups.reduce((sum, g) => sum + Number(g.points[i].marketValueRub), 0);
      const orphan = daily.filter((d) => d.date <= p.date).at(-1)?.orphanSellsRub.toNumber() ?? 0;
      expect(Number(s.netContributionsRub[i]) + result - market, p.date).toBeCloseTo(Number(cash[i]) - orphan, 2);
    });
    expect(orphanSellsRub(ops, FUT).toFixed(2)).toBe('11995.00'); // 1000 × 12 − 5
    expect(cash.at(-1)).toBe(cashBalanceRub(ops, FUT).toFixed(2));
  });

  it('фильтр по счёту: кэш ряда = кэш журнала этого счёта', () => {
    const s = valuationSeries(OPS, PRICES, { till: '2026-06-30', groupBy: 'system', portfolioId: 'p1', futureIds: FUT });
    const p1 = OPS.filter((o) => o.portfolioId === 'p1');
    expect(cashSeries(s, OPS, { portfolioId: 'p1', futureIds: FUT }).at(-1)).toBe(cashBalanceRub(p1, FUT).toFixed(2));
  });
});

describe('valuationEvents: выплаты и продажи для маркеров', () => {
  it('выплаты и продажи спота; фьючерс и налоги не попадают; одна бумага за день сливается', () => {
    const ev = valuationEvents(
      [...OPS, mk({ date: '2026-02-10', operationType: 'Sell', instrumentId: 'SBER', quantity: '10', price: '130' })],
      { till: '2026-06-30', futureIds: FUT },
    );
    expect(ev).toEqual([
      { date: '2026-02-10', kind: 'sale', instrumentId: 'SBER', amountRub: String((40 * 130 + 10 * 130).toFixed(2)) },
      { date: '2026-03-01', kind: 'payout', instrumentId: 'SBER', amountRub: '300.00' },
      { date: '2026-04-01', kind: 'payout', instrumentId: null, amountRub: '777.00' },
      { date: '2026-05-10', kind: 'sale', instrumentId: 'GAZP', amountRub: '9500.00' },
    ]);
  });

  it('фильтры периода и системы', () => {
    const ev = valuationEvents(OPS, { from: '2026-03-01', till: '2026-04-30', systemId: 's1', futureIds: FUT });
    expect(ev.map((e) => e.date)).toEqual(['2026-03-01', '2026-04-01']);
  });
});

describe('спот с известной суммой исполнения', () => {
  const scope = { portfolioId: 'p1' };
  const from = '2026-07-02';
  const ops = [
    mk({ date: '2026-06-30', operationType: 'Deposit', price: '1000' }),
    mk({ date: '2026-07-01', operationType: 'Buy', instrumentId: 'BOND', quantity: '10', price: '40', fee: '2', grossTradeAmount: '420' }),
    mk({ date: from, operationType: 'Coupon', instrumentId: 'BOND', price: '30' }),
    mk({ date: '2026-07-03', operationType: 'Sell', instrumentId: 'BOND', quantity: '4', price: '49', fee: '1', grossTradeAmount: '205' }),
    mk({ date: '2026-07-06', operationType: 'Sell', instrumentId: 'BOND', quantity: '6', price: '49', fee: '3', grossTradeAmount: '315' }),
    mk({ date: '2026-07-07', operationType: 'Withdraw', price: '100' }),
  ];
  const prices = [{ ...px('BOND', '2026-07-01', '50'), accruedInterest: '2', accruedCurrency: 'RUB' }];
  const at = (till: string, periodFrom = from) =>
    valuationSeries(ops, prices, { ...scope, groupBy: 'portfolio', from: periodFrom, till });
  const point = (s: ReturnType<typeof at>) => s.groups[0].points.at(-1);

  it('согласует деньги, рыночную оценку с НКД, среднюю себестоимость и доходность после обеих продаж', () => {
    const bought = at('2026-07-01', '2026-07-01');
    expect(point(bought)).toMatchObject({ purchasesRub: '422.00', investedRub: '422.00', marketValueRub: '520.00' });
    const partial = at('2026-07-03');
    expect(point(partial)).toMatchObject({ investedRub: '253.20', marketValueRub: '312.00', fixedRub: '65.20', totalRub: '124.00' });
    const cash = cashBalanceRub(ops.filter(o => o.date <= partial.till));
    expect(cashSeries(partial, ops, scope).at(-1)).toBe(cash.toFixed(2));
    expect(cash.plus(point(partial)!.marketValueRub).toFixed(2)).toBe('1124.00');
    const position = calculatePositions(ops.filter(o => o.date <= partial.till))[0];
    expect(position.avgBuyPrice.toFixed()).toBe('42.2');

    const closed = at('2026-07-07');
    expect(point(closed)).toMatchObject({ investedRub: '0.00', marketValueRub: '0.00', fixedRub: '124.00', totalRub: '124.00' });
    expect(cashSeries(closed, ops, scope).at(-1)).toBe('1024.00');
    expect(cashBalanceRub(ops).toFixed(2)).toBe('1024.00');
    expect(closed.netContributionsRub.at(-1)).toBe('900.00');
    const [result] = realizedPnlInRange(ops, from, closed.till);
    const [trade] = calculateTrades(ops);
    expect(result.realizedPnlRub.toFixed(2)).toBe('94.00');
    expect(trade.realizedPnlRub.eq(result.realizedPnlRub)).toBe(true);
    expect(trade.couponsRub.toFixed(2)).toBe('30.00');
    const performance = periodPerformance(at(closed.till, '2026-06-30'), {
      from, contour: 'wealth', payoutsRub: payoutsInPeriod(ops, { from, till: closed.till }),
    });
    expect(performance).toMatchObject({
      startValueRub: '1098.00', endValueRub: '1024.00', netFlowRub: '-100.00', resultRub: '26.00',
      breakdown: { fixedRub: '124.00', payoutsRub: '30.00', realizedRub: '94.00', revaluationRub: '-98.00' },
    });
    expect(performance.twr.pct).toBeCloseTo((1124 / 1098 - 1) * 100, 8);
    expect(valuationEvents(ops, { ...scope, from, till: closed.till }).map(e => e.amountRub))
      .toEqual(['30.00', '205.00', '315.00']);
  });

  it('конвертирует выручку от продажи без позиции по историческому курсу один раз', () => {
    const orphan = mk({
      date: '2026-07-06', operationType: 'Sell', instrumentId: 'OTHER', quantity: '6',
      price: '49', fee: '3', grossTradeAmount: '315', fxRate: '90', currency: 'USD',
    });
    expect(cashDelta(orphan).toFixed()).toBe('28080');
    expect(orphanSellsRub([orphan]).toFixed()).toBe('28080');
    expect(valuationEvents([orphan], { till: orphan.date })[0].amountRub).toBe('28350.00');
  });
});
