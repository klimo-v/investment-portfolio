import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { calculatePositions, calculateTrades, realizedPnlInRange, TradeLedger } from './engine';
import { valuationSeries } from './valuation';
import { systemPerformance } from './performance';
import type { Operation } from './schemas';

const op = (
  id: string,
  date: string,
  operationType: Operation['operationType'],
  quantity: string,
  price: string,
  fxRate = '1',
  fee = '0',
): Operation => ({
  id,
  date,
  operationType,
  quantity,
  price,
  fxRate,
  fee,
  currency: 'USD',
  instrumentId: 'X',
  systemId: 's',
  portfolioId: 'p',
});
const sum = (values: Decimal[]) => values.reduce((a, b) => a.plus(b), new Decimal(0));

describe('Историческая рублёвая себестоимость во всех потребителях', () => {
  const buy = op('buy', '2026-01-01', 'Buy', '2', '100', '90');
  const first = op('first', '2026-02-01', 'Sell', '1', '100', '100');
  const second = op('second', '2026-03-01', 'Sell', '1', '100', '100');
  it('частичная продажа: +1000 ₽, остаток 9000 ₽, $0; события и период совпадают', () => {
    const ops = [buy, first];
    const [position] = calculatePositions(ops);
    const [trade] = calculateTrades(ops);
    for (const result of [position, trade]) {
      expect(result.realizedPnlRub.toString()).toBe('1000');
      expect(result.investedRub.toString()).toBe('9000');
      expect(result.realizedPnlCcy.toString()).toBe('0');
    }
    expect(trade.purchasesRub.toString()).toBe('18000');
    expect(sum(trade.events.map((e) => e.rub)).toString()).toBe('1000');
    expect(realizedPnlInRange(ops, first.date, first.date)[0].realizedPnlRub.toString()).toBe(
      '1000',
    );
  });
  it('переоценка остатка и дневной ряд не считают валютный результат дважды', () => {
    const ops = [buy, first];
    const series = valuationSeries(
      ops,
      [
        { instrumentId: 'X', date: buy.date, price: '100', currency: 'USD', source: 'manual' },
        { instrumentId: 'fx:USD', date: buy.date, price: '90', currency: 'RUB', source: 'cbr' },
        { instrumentId: 'fx:USD', date: first.date, price: '100', currency: 'RUB', source: 'cbr' },
      ],
      { groupBy: 'system', till: first.date },
    );
    const point = series.groups[0].points.at(-1)!;
    expect(point.fixedRub).toBe('1000.00');
    expect(point.unrealizedRub).toBe('1000.00');
    expect(point.totalRub).toBe('2000.00');
    const performance = systemPerformance(calculateTrades(ops), {
      unrealizedOf: (t) => new Decimal(10000).minus(t.investedRub),
    });
    expect(performance.summary.totalRub).toBe('2000.00');
  });
  it('полное закрытие: ещё +1000 ₽, обе себестоимости обнуляются, сумма покупок остаётся', () => {
    const ledger = new TradeLedger();
    for (const operation of [buy, first, second]) ledger.apply(operation);
    const [trade] = ledger.trades();
    const [position] = calculatePositions([buy, first, second]);
    for (const result of [position, trade]) {
      expect(result.realizedPnlRub.toString()).toBe('2000');
      expect(result.realizedPnlCcy.toString()).toBe('0');
      expect(result.investedRub.toString()).toBe('0');
      expect(result.investedCcy.toString()).toBe('0');
    }
    expect(trade.events.map((e) => e.rub.toString())).toEqual(['1000', '1000']);
    expect(trade.purchasesRub.toString()).toBe('18000');
    expect(
      realizedPnlInRange(
        [buy, first, second],
        second.date,
        second.date,
      )[0].realizedPnlRub.toString(),
    ).toBe('1000');
  });
  it('разные курсы покупок, комиссии, повторное открытие; без округления доли до списания', () => {
    const ops = [
      op('b1', '2026-01-01', 'Buy', '1', '100', '90', '1'),
      op('b2', '2026-01-02', 'Buy', '2', '110', '100', '2'),
      op('s1', '2026-02-01', 'Sell', '1', '120', '110', '1'),
      op('s2', '2026-02-02', 'Sell', '2', '120', '110', '2'),
    ];
    const [partial] = calculateTrades(ops.slice(0, 3));
    expect(partial.realizedPnlRub.toString()).toBe('2660');
    expect(partial.investedRub.toString()).toBe('20860');
    const [closed] = calculateTrades(ops);
    expect(closed.realizedPnlRub.toString()).toBe('7980');
    expect(closed.realizedPnlCcy.toFixed(10)).toBe('34.0000000000');
    expect(closed.purchasesRub.toString()).toBe('31290');
    expect(closed.investedCcy.toString()).toBe('0');
    expect(closed.feesRub.toString()).toBe('620');
    expect(sum(closed.events.map((e) => e.rub)).eq(closed.realizedPnlRub)).toBe(true);
    const reopened = [
      ...ops,
      op('b3', '2026-03-01', 'Buy', '1', '100', '80'),
      op('s3', '2026-03-02', 'Sell', '1', '100', '90'),
    ];
    const trades = calculateTrades(reopened);
    expect(trades.map((t) => t.purchasesRub.toString())).toEqual(['31290', '8000']);
    expect(
      calculatePositions(reopened)[0].realizedPnlRub.eq(sum(trades.map((t) => t.realizedPnlRub))),
    ).toBe(true);
    expect(realizedPnlInRange(reopened, '2026-01-01')[0].realizedPnlRub.toString()).toBe('8980');
  });
  it('рублёвая сделка: комиссия один раз; поздний дивиденд не меняет торговую прибыль', () => {
    const ops = [
      op('b', '2026-01-01', 'Buy', '1', '100', '1', '2'),
      op('s', '2026-01-02', 'Sell', '1', '95', '1', '3'),
      op('d', '2026-01-03', 'Dividend', '1', '20'),
    ].map((o) => ({ ...o, currency: 'RUB' }));
    const [trade] = calculateTrades(ops);
    expect(trade.realizedPnlRub.toString()).toBe('-10');
    expect(trade.dividendsRub.toString()).toBe('20');
    expect(sum(trade.events.map((e) => e.rub)).toString()).toBe('10');
    expect(trade.purchasesRub.toString()).toBe('102');
    expect(calculatePositions(ops)[0].realizedPnlRub.toString()).toBe('-10');
  });
});
