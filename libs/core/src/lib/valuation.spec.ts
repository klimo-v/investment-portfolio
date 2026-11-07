import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import type { Operation } from './schemas';
import { calculateTrades, marketValueRub } from './engine';
import { futureUnrealizedPnl } from './futures-engine';
import { systemPerformance } from './performance';
import { timeWeightedIndex, valuationSeries, type PriceObservation, type ValuationSeries } from './valuation';

const base = { fee: '0', fxRate: '1', currency: 'RUB' } as const;
const op = (o: Partial<Operation> & Pick<Operation, 'date' | 'operationType' | 'instrumentId'>): Operation =>
  ({ systemId: 's1', portfolioId: 'p1', quantity: '1', price: '0', ...base, ...o }) as Operation;

const px = (instrumentId: string, date: string, price: string, extra: Partial<PriceObservation> = {}): PriceObservation => ({
  instrumentId,
  date,
  price,
  currency: 'RUB',
  accruedInterest: null,
  accruedCurrency: null,
  ...extra,
});

const FUT = new Set(['CNY-12.26']);
const TODAY = '2026-04-10'; // пятница

/** Журнал на две системы и два портфеля: спот с частичной продажей и дивидендом, облигация в USD с НКД в ₽, фьючерс с переворотом */
const OPS: Operation[] = [
  op({ date: '2026-03-02', operationType: 'Buy', instrumentId: 'SBER', quantity: '10', price: '100' }),
  op({ date: '2026-03-09', operationType: 'Sell', instrumentId: 'SBER', quantity: '4', price: '130' }),
  op({ date: '2026-03-16', operationType: 'Dividend', instrumentId: 'SBER', quantity: '1', price: '50' }),
  op({ date: '2026-03-03', operationType: 'Buy', instrumentId: 'BOND', quantity: '5', price: '100', fxRate: '90', currency: 'USD', systemId: 's2' }),
  op({ date: '2026-03-04', operationType: 'Buy', instrumentId: 'GAZP', quantity: '3', price: '200', portfolioId: 'p2', systemId: 's2' }),
  op({ date: '2026-03-20', operationType: 'Sell', instrumentId: 'GAZP', quantity: '3', price: '210', portfolioId: 'p2', systemId: 's2' }),
  op({ date: '2026-03-05', operationType: 'Buy', instrumentId: 'CNY-12.26', quantity: '2', price: '12000', fee: '10', portfolioId: 'p2', systemId: 's1' }),
  op({ date: '2026-03-23', operationType: 'Sell', instrumentId: 'CNY-12.26', quantity: '3', price: '12200', fee: '15', portfolioId: 'p2', systemId: 's1' }),
  op({ date: '2026-03-12', operationType: 'Transfer', instrumentId: 'SBER', quantity: '1', price: '100', portfolioId: 'p2' }),
];

const PRICES: PriceObservation[] = [
  px('SBER', '2026-03-02', '101'),
  px('SBER', '2026-03-13', '120'),
  px('SBER', '2026-04-10', '125'),
  // облигация: цена в USD, НКД в рублях (как RU000A10B4K3), курс доллара в той же истории
  px('BOND', '2026-03-03', '100', { currency: 'USD', accruedInterest: '40', accruedCurrency: 'RUB' }),
  px('BOND', '2026-04-10', '101', { currency: 'USD', accruedInterest: '42', accruedCurrency: 'RUB' }),
  px('fx:USD', '2026-03-01', '90'),
  px('fx:USD', '2026-04-10', '95'),
  px('GAZP', '2026-03-04', '201'),
  px('CNY-12.26', '2026-03-05', '12010'),
  px('CNY-12.26', '2026-03-24', '12100'),
  px('CNY-12.26', '2026-04-10', '12050'),
];

const opts = (groupBy: 'portfolio' | 'system' | 'instrument', extra = {}) => ({ till: TODAY, groupBy, futureIds: FUT, ...extra });
const last = (s: ValuationSeries, key: string) => {
  const g = s.groups.find((x) => x.key === key);
  return g!.points[g!.points.length - 1];
};
const sum = (s: ValuationSeries, i: number, field: 'investedRub' | 'marketValueRub' | 'fixedRub' | 'unrealizedRub' | 'totalRub') =>
  s.groups.reduce((acc, g) => acc.plus(g.points[i][field]), new Decimal(0)).toFixed(2);

describe('valuationSeries: инварианты', () => {
  it('точка «сегодня» при текущих ценах = итог по сделкам (systemPerformance.summary.totalRub) по каждой системе', () => {
    const series = valuationSeries(OPS, PRICES, opts('system'));
    for (const systemId of ['s1', 's2']) {
      const trades = calculateTrades(OPS.filter((o) => o.systemId === systemId), { futureIds: FUT });
      // ровно то, что делает OperationsService.valuedTrades на текущих котировках
      const unrealized = (t: (typeof trades)[number]): Decimal | null => {
        if (FUT.has(t.instrumentId)) {
          return t.quantity.isZero() ? null : futureUnrealizedPnl({ quantity: t.quantity, avgBuyPrice: t.avgBuyPrice }, '12050');
        }
        if (t.instrumentId === 'SBER') return marketValueRub({ quantity: t.quantity, price: '125', fxRate: 1 }).minus(t.investedRub);
        if (t.instrumentId === 'BOND') {
          return marketValueRub({ quantity: t.quantity, price: '101', fxRate: 95, accruedInterest: '42', accruedFxRate: 1 }).minus(t.investedRub);
        }
        return null;
      };
      const expected = systemPerformance(trades, { unrealizedOf: unrealized }).summary.totalRub;
      expect(last(series, systemId).totalRub).toBe(expected);
    }
  });

  it('сумма рядов по системам = сумма по портфелям = сумма по инструментам, по каждому дню и каждому полю', () => {
    const bySystem = valuationSeries(OPS, PRICES, opts('system'));
    const byPortfolio = valuationSeries(OPS, PRICES, opts('portfolio'));
    const byInstrument = valuationSeries(OPS, PRICES, opts('instrument'));
    const days = bySystem.groups[0].points.length;
    expect(days).toBeGreaterThan(30);
    for (let i = 0; i < days; i++) {
      for (const f of ['investedRub', 'marketValueRub', 'fixedRub', 'unrealizedRub', 'totalRub'] as const) {
        expect(sum(byPortfolio, i, f)).toBe(sum(bySystem, i, f));
        expect(sum(byInstrument, i, f)).toBe(sum(bySystem, i, f));
      }
    }
  });

  it('без цен: зафиксированное совпадает с кривой «Результат системы» (series.result), переоценка 0, все инструменты помечены', () => {
    const s1 = OPS.filter((o) => o.systemId === 's1');
    const series = valuationSeries(s1, [], opts('system'));
    const perf = systemPerformance(calculateTrades(s1, { futureIds: FUT }));
    const points = series.groups[0].points;
    for (const r of perf.series.result) {
      const p = points.find((x) => x.date === r.date);
      if (p && r.fixedRub !== '0.00') expect(p.fixedRub).toBe(r.fixedRub);
    }
    expect(points.every((p) => p.unrealizedRub === '0.00')).toBe(true);
    expect(points.some((p) => p.carried.some((c) => c.reason === 'no-price'))).toBe(true);
  });
});

describe('valuationSeries: оценка позиций', () => {
  it('облигация в USD: цена × курс дня; НКД в рублях НЕ умножается на курс доллара', () => {
    const series = valuationSeries(OPS, PRICES, opts('instrument'));
    const bond = last(series, 'BOND');
    // 5 × (101 × 95 + 42 × 1) = 5 × 9637 = 48185; вложено 5 × 100 × 90 = 45000
    expect(bond.marketValueRub).toBe('48185.00');
    expect(bond.investedRub).toBe('45000.00');
    expect(bond.unrealizedRub).toBe('3185.00');
    // на дату первой цены курс — 90 (последний ≤ дня)
    const early = series.groups.find((g) => g.key === 'BOND')!.points.find((p) => p.date === '2026-03-03')!;
    expect(early.marketValueRub).toBe('45200.00'); // 5 × (100×90 + 40)
  });

  it('фьючерс с переворотом: лонг 2 → продажа 3 → шорт 1; стоимость = нереализованный по знаку позиции', () => {
    const series = valuationSeries(OPS, PRICES, opts('instrument'));
    const pts = series.groups.find((g) => g.key === 'CNY-12.26')!.points;
    const at = (d: string) => pts.find((p) => p.date === d)!;
    // 05.03 лонг 2 по 12000, расчётная 12010: +20
    expect(at('2026-03-05').marketValueRub).toBe('20.00');
    // после переворота 23.03: шорт 1 по 12200, цена на 23.03 — ещё 12010 → (12010−12200)×(−1) = +190
    expect(at('2026-03-23').marketValueRub).toBe('190.00');
    // сегодня: цена 12050 → (12050−12200)×(−1) = +150; вложено 0
    expect(last(series, 'CNY-12.26')).toMatchObject({ marketValueRub: '150.00', investedRub: '0.00', unrealizedRub: '150.00' });
    // зафиксировано = реализованный результат сделок движка (с комиссиями), то есть та же арифметика
    const trades = calculateTrades(OPS.filter((o) => o.instrumentId === 'CNY-12.26'), { futureIds: FUT });
    const fixed = trades.reduce((acc, t) => acc.plus(t.realizedPnlRub), new Decimal(0)).toFixed(2);
    expect(last(series, 'CNY-12.26').fixedRub).toBe(fixed);
  });

  it('инструмент без единой цены: оценка по себестоимости, переоценка 0, пометка no-price', () => {
    const series = valuationSeries(OPS, PRICES.filter((p) => p.instrumentId !== 'SBER'), opts('instrument'));
    const sber = last(series, 'SBER');
    expect(sber.unrealizedRub).toBe('0.00');
    expect(sber.marketValueRub).toBe(sber.investedRub);
    expect(sber.carried).toEqual([{ instrumentId: 'SBER', reason: 'no-price', priceDate: null }]);
  });

  it('нет курса валюты цены: себестоимость и пометка no-fx, а не молчаливая единица', () => {
    const series = valuationSeries(OPS, PRICES.filter((p) => p.instrumentId !== 'fx:USD'), opts('instrument'));
    const bond = last(series, 'BOND');
    expect(bond.unrealizedRub).toBe('0.00');
    expect(bond.carried[0]).toMatchObject({ instrumentId: 'BOND', reason: 'no-fx' });
  });

  it('перенос цены: выходные не помечаются, пропущенный будний день — помечается', () => {
    const series = valuationSeries(OPS, PRICES, opts('instrument'));
    const pts = series.groups.find((g) => g.key === 'SBER')!.points;
    const day = (d: string) => pts.find((p) => p.date === d)!;
    expect(day('2026-03-14').carried).toEqual([]); // суббота: цена 13.03 перенесена, но это выходной
    expect(day('2026-03-17').carried).toEqual([{ instrumentId: 'SBER', reason: 'carried', priceDate: '2026-03-13' }]);
    expect(day('2026-03-13').carried).toEqual([]); // цена именно этого дня
  });

  it('Transfer не меняет позиции и результат', () => {
    const withTransfer = valuationSeries(OPS, PRICES, opts('portfolio'));
    const without = valuationSeries(OPS.filter((o) => o.operationType !== 'Transfer'), PRICES, opts('portfolio'));
    expect(withTransfer.groups.map((g) => g.points.map((p) => p.totalRub))).toEqual(
      without.groups.map((g) => g.points.map((p) => p.totalRub)),
    );
  });
});

describe('valuationSeries: фильтры и операции задним числом', () => {
  it('операция задним числом меняет только дни ≥ её даты', () => {
    const before = valuationSeries(OPS, PRICES, opts('system'));
    const backdated = [...OPS, op({ date: '2026-03-18', operationType: 'Sell', instrumentId: 'SBER', quantity: '2', price: '140' })];
    const after = valuationSeries(backdated, PRICES, opts('system'));
    const a = before.groups.find((g) => g.key === 's1')!.points;
    const b = after.groups.find((g) => g.key === 's1')!.points;
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      if (a[i].date < '2026-03-18') expect(b[i]).toEqual(a[i]);
    }
    expect(b.find((p) => p.date === '2026-03-18')!.fixedRub).not.toBe(a.find((p) => p.date === '2026-03-18')!.fixedRub);
  });

  it('from обрезает вывод, но состояние до from учтено; фильтр по системе и портфелю', () => {
    const full = valuationSeries(OPS, PRICES, opts('system'));
    const cut = valuationSeries(OPS, PRICES, opts('system', { from: '2026-03-20' }));
    const fullS1 = full.groups.find((g) => g.key === 's1')!.points;
    const cutS1 = cut.groups.find((g) => g.key === 's1')!.points;
    expect(cutS1[0].date).toBe('2026-03-20');
    expect(cutS1[0]).toEqual(fullS1.find((p) => p.date === '2026-03-20'));

    const onlyP2 = valuationSeries(OPS, PRICES, opts('system', { portfolioId: 'p2' }));
    expect(onlyP2.groups.map((g) => g.key)).toEqual(['s1', 's2']);
    expect(last(onlyP2, 's2').investedRub).toBe('0.00'); // GAZP в p2 продан целиком
  });

  it('пустой журнал — пустой ряд', () => {
    expect(valuationSeries([], PRICES, opts('system')).groups).toEqual([]);
  });
});

describe('выплата после закрытия позиции', () => {
  const ops: Operation[] = [
    op({ date: '2026-03-02', operationType: 'Buy', instrumentId: 'SBER', quantity: '10', price: '100' }),
    op({ date: '2026-03-09', operationType: 'Sell', instrumentId: 'SBER', quantity: '10', price: '110' }), // +100
    op({ date: '2026-03-16', operationType: 'Dividend', instrumentId: 'SBER', quantity: '1', price: '70' }), // после закрытия
  ];

  it('дивиденд, зачисленный после продажи, относится к закрытой сделке и входит в итог и в кривую', () => {
    const [t] = calculateTrades(ops);
    expect(t.status).toBe('Closed');
    expect(t.dividendsRub.toString()).toBe('70');
    const perf = systemPerformance([t]);
    expect(perf.summary).toMatchObject({ netPnlRub: '100.00', closedIncomeRub: '70.00', closedResultRub: '170.00', totalRub: '170.00' });

    const series = valuationSeries(ops, [], { till: '2026-03-20', groupBy: 'system' });
    const pts = series.groups[0].points;
    expect(pts.find((p) => p.date === '2026-03-15')!.fixedRub).toBe('100.00');
    expect(pts[pts.length - 1].totalRub).toBe('170.00'); // = summary.totalRub
  });

  it('выплата по позиции, которой не было вовсе, пропускается', () => {
    const orphan = [op({ date: '2026-03-16', operationType: 'Dividend', instrumentId: 'X', quantity: '1', price: '70' })];
    expect(calculateTrades(orphan)).toEqual([]);
  });
});

describe('чистый ввод средств', () => {
  it('депозиты минус выводы нарастающим итогом по тем же дням, что и точки; фильтр портфеля применяется', () => {
    const ops: Operation[] = [
      op({ date: '2026-03-02', operationType: 'Deposit', instrumentId: null as never, quantity: '1', price: '1000' }),
      op({ date: '2026-03-02', operationType: 'Buy', instrumentId: 'SBER', quantity: '10', price: '100' }),
      op({ date: '2026-03-04', operationType: 'Withdraw', instrumentId: null as never, quantity: '1', price: '300' }),
      op({ date: '2026-03-04', operationType: 'Deposit', instrumentId: null as never, quantity: '1', price: '50', portfolioId: 'p2' }),
    ];
    const s = valuationSeries(ops, [], { till: '2026-03-05', groupBy: 'portfolio' });
    expect(s.netContributionsRub).toEqual(['1000.00', '1000.00', '750.00', '750.00']);
    expect(s.netContributionsRub).toHaveLength(s.groups[0].points.length);
    const p1 = valuationSeries(ops, [], { till: '2026-03-05', groupBy: 'portfolio', portfolioId: 'p1' });
    expect(p1.netContributionsRub).toEqual(['1000.00', '1000.00', '700.00', '700.00']);
  });
});

describe('timeWeightedIndex: доходность без потоков', () => {
  it('довнесение и продажа индекс не двигают, рост цены — двигает', () => {
    const idx = timeWeightedIndex([
      { totalRub: 0, netContributionsRub: 1000 }, // внесли 1000, ещё не покупали
      { totalRub: 100, netContributionsRub: 1000 }, // +10%
      { totalRub: 100, netContributionsRub: 2000 }, // довнесли 1000 — индекс не растёт
      { totalRub: 100, netContributionsRub: 2000 }, // продали позицию (кэш) — итог тот же, индекс не падает
      { totalRub: 320, netContributionsRub: 2000 }, // +220 на 2100 ≈ +10,476%
    ]);
    expect(idx[0]).toBe(100);
    expect(idx[1]).toBeCloseTo(110, 10);
    expect(idx[2]).toBeCloseTo(110, 10);
    expect(idx[3]).toBeCloseTo(110, 10);
    expect(idx[4]).toBeCloseTo(110 * (1 + 220 / 2100), 10);
  });

  it('вывод денег не падение; убыток — падение; до первого богатства база 100', () => {
    const idx = timeWeightedIndex([
      { totalRub: 0, netContributionsRub: 0 },
      { totalRub: 0, netContributionsRub: 1000 },
      { totalRub: -100, netContributionsRub: 1000 }, // −10%
      { totalRub: -100, netContributionsRub: 500 }, // вывели 500: богатство 400 → 400−900−(−500)=0, доходность 0
    ]);
    expect(idx[0]).toBe(100);
    expect(idx[1]).toBe(100);
    expect(idx[2]).toBeCloseTo(90, 10);
    expect(idx[3]).toBeCloseTo(90, 10);
  });

  it('нулевое/отрицательное богатство не даёт деления на ноль', () => {
    const idx = timeWeightedIndex([
      { totalRub: -50, netContributionsRub: 0 },
      { totalRub: -20, netContributionsRub: 0 },
    ]);
    expect(idx.every(Number.isFinite)).toBe(true);
  });
});

describe('выплаты без инструмента', () => {
  const ops: Operation[] = [
    op({ date: '2026-03-02', operationType: 'Buy', instrumentId: 'SBER', quantity: '10', price: '100' }),
    op({ date: '2026-03-10', operationType: 'Dividend', instrumentId: null as never, quantity: '1', price: '500', note: 'КЦ ИКС 5' } as never),
    op({ date: '2026-03-12', operationType: 'Coupon', instrumentId: null as never, quantity: '1', price: '200', portfolioId: 'p2', systemId: 's2' }),
  ];

  it('входят в зафиксированное по дате выплаты и в итог для любой группировки; суммы групп сходятся', () => {
    for (const groupBy of ['system', 'portfolio', 'instrument'] as const) {
      const s = valuationSeries(ops, [], { till: '2026-03-14', groupBy });
      const lastTotal = s.groups.reduce((acc, g) => acc.plus(g.points[g.points.length - 1].totalRub), new Decimal(0));
      expect(lastTotal.toFixed(2)).toBe('700.00');
      const dayBefore = s.groups.reduce((acc, g) => acc.plus(g.points.find((p) => p.date === '2026-03-09')!.fixedRub), new Decimal(0));
      expect(dayBefore.toFixed(2)).toBe('0.00');
    }
    const byInstrument = valuationSeries(ops, [], { till: '2026-03-14', groupBy: 'instrument' });
    expect(byInstrument.groups.map((g) => g.key)).toEqual(['SBER', 'no-instrument']);
  });

  it('итог системы: перечисленные в option выплаты входят в «Всего» и в «Результат (закрытые)»', () => {
    const trades = calculateTrades(ops.filter((o) => o.instrumentId));
    const p = systemPerformance(trades, { unrealizedOf: () => new Decimal(30), unattributedIncomeRub: '500' });
    expect(p.summary).toMatchObject({ incomeRub: '500.00', closedIncomeRub: '500.00', closedResultRub: '500.00', openResultRub: '30.00', totalRub: '530.00' });
  });
});
