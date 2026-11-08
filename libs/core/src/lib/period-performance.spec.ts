import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import type { Operation } from './schemas';
import { PERIOD_FIXTURES, type PeriodFixture } from './period-performance.fixture';
import { contourDays, payoutsInPeriod, periodPerformance } from './period-performance';
import { valuationSeries, type PriceObservation, type ValuationSeries } from './valuation';

/** Ряд valuationSeries из точек фикстуры: одна группа, зафиксированное = итог, переоценка 0 */
function seriesOf(f: PeriodFixture): ValuationSeries {
  return {
    from: f.points[0].date,
    till: f.points[f.points.length - 1].date,
    groupBy: 'portfolio',
    groups: [
      {
        key: 'all',
        points: f.points.map((p) => ({
          date: p.date,
          investedRub: '0',
          marketValueRub: String(p.marketValueRub),
          fixedRub: String(p.totalRub),
          unrealizedRub: '0',
          totalRub: String(p.totalRub),
          carried: [],
        })),
      },
    ],
    netContributionsRub: f.points.map((p) => String(p.netContributionsRub)),
  };
}

const dayAfter = (iso: string): string => new Date(Date.parse(iso) + 86_400_000).toISOString().slice(0, 10);

describe('periodPerformance — эталоны этапа 0 (ручные ответы)', () => {
  it.each(PERIOD_FIXTURES)('$name — результат, TWR и доходность денег совпадают с ручным расчётом', (f) => {
    const perf = periodPerformance(seriesOf(f), { from: dayAfter(f.points[0].date), contour: 'wealth' });
    expect(Number(perf.resultRub)).toBeCloseTo(f.expected.resultRub, 2);
    const last = perf.twr.series[perf.twr.series.length - 1];
    expect(last.index).toBeCloseTo(f.expected.twrIndex, 6);
    // 365 дней → годовая метрика, это XIRR
    expect(perf.mwr.kind).toBe('annual');
    expect(Math.abs((perf.mwr.pct as number) - f.expected.mwrPct)).toBeLessThan(f.expected.mwrTolerancePp);
  });

  it('открытые позиции на начало периода: база по рынку (150 000), результат 15 000, а не 65 000', () => {
    const f = PERIOD_FIXTURES.find((x) => x.name === 'openAtStart') as PeriodFixture;
    const perf = periodPerformance(seriesOf(f), { from: '2025-01-01', contour: 'wealth' });
    expect(perf.startValueRub).toBe('150000.00');
    expect(perf.resultRub).toBe('15000.00');
    expect(perf.dietzPct).toBeCloseTo(10, 6);
  });

  it('короткий период — доходность за период (Dietz), не годовая; длинный — XIRR', () => {
    const f = PERIOD_FIXTURES.find((x) => x.name === 'noFlows') as PeriodFixture;
    const short = { ...f, points: [f.points[0], { ...f.points[1], date: '2025-03-31' }] };
    const perf = periodPerformance(seriesOf(short), { from: '2025-01-01', contour: 'wealth' });
    expect(perf.days).toBe(90);
    expect(perf.mwr.kind).toBe('period');
    expect(perf.mwr.pct).toBeCloseTo(10, 6);
    expect(perf.xirrPct).toBeGreaterThan(40); // аннуализированные 10% за квартал — «шум», его не показываем
  });

  it('средний капитал (Modified Dietz): ввод в середине периода работает полпериода', () => {
    const f = PERIOD_FIXTURES.find((x) => x.name === 'midDepositBeforeFlat') as PeriodFixture;
    const perf = periodPerformance(seriesOf(f), { from: '2025-01-01', contour: 'wealth' });
    // 100 000 весь год + 100 000 с 02.07 (183 из 365 дней) ≈ 150 137
    expect(Number(perf.averageCapitalRub)).toBeCloseTo(100_000 + (100_000 * 183) / 365, 0);
    expect(perf.dietzPct).toBeCloseTo((10_000 / Number(perf.averageCapitalRub)) * 100, 6);
  });

  it('ввод 2 млн после почти нулевого остатка не даёт ложной просадки', () => {
    const f: PeriodFixture = {
      name: 'x',
      description: '',
      points: [
        { date: '2025-03-07', marketValueRub: 1_198, totalRub: 0, netContributionsRub: 1_198 },
        // 2 000 000 внесено, в тот же день −976 ₽ на комиссиях/переоценке
        { date: '2025-03-10', marketValueRub: 2_000_222, totalRub: -976, netContributionsRub: 2_001_198 },
      ],
      expected: { resultRub: -976, twrIndex: 0, mwrPct: 0, mwrTolerancePp: 0 },
    };
    const perf = periodPerformance(seriesOf(f), { from: '2025-03-08', contour: 'wealth' });
    expect(perf.twr.pct as number).toBeGreaterThan(-0.1);
  });
});

// --- ряд из журнала: два портфеля-контура, системы, выплаты, ввод/вывод ---

const mk = (o: Partial<Operation> & Pick<Operation, 'date' | 'operationType'>): Operation =>
  ({
    portfolioId: 'p1',
    systemId: 's1',
    quantity: '1',
    price: '0',
    fee: '0',
    fxRate: '1',
    currency: 'RUB',
    ...o,
  }) as Operation;

const OPS: Operation[] = [
  mk({ date: '2026-01-05', operationType: 'Deposit', price: '1000000' }),
  mk({ date: '2026-01-06', operationType: 'Buy', instrumentId: 'SBER', quantity: '100', price: '100' }),
  mk({ date: '2026-01-07', operationType: 'Buy', instrumentId: 'GAZP', quantity: '50', price: '200', systemId: 's2' }),
  mk({ date: '2026-02-10', operationType: 'Sell', instrumentId: 'SBER', quantity: '40', price: '130' }),
  mk({ date: '2026-03-01', operationType: 'Dividend', instrumentId: 'SBER', quantity: '1', price: '300' }),
  mk({ date: '2026-03-15', operationType: 'Deposit', price: '500000', systemId: 's2' }),
  // выплата без инструмента: в итог входит отдельным потоком
  mk({ date: '2026-04-01', operationType: 'Dividend', quantity: '1', price: '777' }),
  mk({ date: '2026-04-20', operationType: 'Withdraw', price: '200000' }),
  mk({ date: '2026-05-10', operationType: 'Sell', instrumentId: 'GAZP', quantity: '50', price: '190', systemId: 's2' }),
  mk({ date: '2026-06-01', operationType: 'Buy', instrumentId: 'SBER', quantity: '10', price: '125' }),
];

const px = (instrumentId: string, date: string, price: string): PriceObservation => ({
  instrumentId,
  date,
  price,
  currency: 'RUB',
  accruedInterest: null,
  accruedCurrency: null,
});

const PRICES: PriceObservation[] = [
  px('SBER', '2026-01-06', '100'),
  px('SBER', '2026-02-10', '130'),
  px('SBER', '2026-03-10', '140'),
  px('SBER', '2026-05-01', '120'),
  px('SBER', '2026-06-15', '150'),
  px('GAZP', '2026-01-07', '200'),
  px('GAZP', '2026-03-01', '210'),
  px('GAZP', '2026-05-10', '190'),
];

const series = (groupBy: 'portfolio' | 'system' | 'instrument', till = '2026-06-30') =>
  valuationSeries(OPS, PRICES, { till, groupBy });

describe('periodPerformance — инварианты на ряде из журнала', () => {
  it.each(['wealth', 'positions'] as const)('результат ₽ = V_end − V_start − ΣF = Δзафиксированного + Δпереоценки (%s)', (contour) => {
    const s = series('instrument');
    const days = contourDays(s, contour);
    const perf = periodPerformance(s, { from: '2026-02-01', contour });
    const sum = new Decimal(perf.breakdown.fixedRub).plus(perf.breakdown.revaluationRub);
    const viaFlows = new Decimal(perf.endValueRub).minus(perf.startValueRub).minus(perf.netFlowRub);
    expect(perf.resultRub).toBe(sum.toFixed(2));
    expect(perf.resultRub).toBe(viaFlows.toFixed(2));
    // и это ровно приращение накопленного итога ряда
    const i = days.findIndex((d) => d.date >= '2026-02-01');
    const delta = days[days.length - 1].result.minus(days[i - 1].result);
    expect(perf.resultRub).toBe(delta.toFixed(2));
  });

  it('разбивка: зафиксированное = реализованное + выплаты; выплаты берутся из журнала', () => {
    const s = series('instrument');
    const payouts = payoutsInPeriod(OPS, { from: '2026-02-01', till: '2026-06-30' });
    expect(payouts.toFixed(2)).toBe('1077.00'); // 300 по SBER + 777 без инструмента
    const perf = periodPerformance(s, { from: '2026-02-01', contour: 'wealth', payoutsRub: payouts });
    expect(perf.breakdown.payoutsRub).toBe('1077.00');
    const realized = new Decimal(perf.breakdown.realizedRub as string);
    expect(realized.plus(perf.breakdown.payoutsRub as string).toFixed(2)).toBe(perf.breakdown.fixedRub);
    // продажа 40 SBER: (130 − 100) × 40 = +1200; продажа 50 GAZP: (190 − 200) × 50 = −500
    expect(realized.toFixed(2)).toBe('700.00');
  });

  it('последняя точка ряда индекса = TWR карточки (один расчёт)', () => {
    for (const from of [undefined, '2026-02-01', '2026-04-15']) {
      const perf = periodPerformance(series('portfolio'), { from, contour: 'wealth' });
      const last = perf.twr.series[perf.twr.series.length - 1].index;
      expect(perf.twr.pct).not.toBeNull();
      expect(last - 100).toBeCloseTo(perf.twr.pct as number, 10);
    }
  });

  it('аддитивность ₽: результат(до 31.03) + результат(с 01.04) = результат(весь период)', () => {
    const whole = periodPerformance(series('instrument'), { contour: 'wealth' });
    const first = periodPerformance(series('instrument', '2026-03-31'), { contour: 'wealth' });
    const second = periodPerformance(series('instrument'), { from: '2026-04-01', contour: 'wealth' });
    expect(new Decimal(first.resultRub).plus(second.resultRub).toFixed(2)).toBe(whole.resultRub);
    // и по трём частям
    const mid = periodPerformance(series('instrument'), { from: '2026-02-01', contour: 'wealth' });
    const head = periodPerformance(series('instrument', '2026-01-31'), { contour: 'wealth' });
    expect(new Decimal(head.resultRub).plus(mid.resultRub).toFixed(2)).toBe(whole.resultRub);
  });

  it('ряд индекса начинается с точки базы 100 — и у периода с первой операции (условный день перед первой точкой)', () => {
    const all = periodPerformance(series('portfolio'), { contour: 'wealth' });
    expect(all.twr.series[0]).toEqual({ date: '2026-01-05', index: 100 }); // ряд идёт с первой сделки (06.01)
    const part = periodPerformance(series('portfolio'), { from: '2026-02-01', contour: 'wealth' });
    expect(part.twr.series[0]).toEqual({ date: '2026-01-31', index: 100 });
  });

  it('просадка ряда TWR: наибольшее падение от пика до дна, % (≤ 0); рост без откатов — 0', () => {
    const rising = periodPerformance(series('portfolio', '2026-02-09'), { contour: 'wealth' });
    expect(rising.maxDrawdownPct).toBe(0);
    const f = PERIOD_FIXTURES.find((x) => x.name === 'midDepositBeforeFlat') as PeriodFixture;
    // индекс 100 → 110 → 110 → 110: падений нет
    expect(periodPerformance(seriesOf(f), { from: '2025-01-01', contour: 'wealth' }).maxDrawdownPct).toBe(0);
    const falling: PeriodFixture = {
      ...f,
      points: [
        { date: '2024-12-31', marketValueRub: 100_000, totalRub: 0, netContributionsRub: 100_000 },
        { date: '2025-03-01', marketValueRub: 120_000, totalRub: 20_000, netContributionsRub: 100_000 },
        { date: '2025-06-01', marketValueRub: 90_000, totalRub: -10_000, netContributionsRub: 100_000 },
      ],
    };
    // пик 120, дно 90 → −25%
    expect(periodPerformance(seriesOf(falling), { from: '2025-01-01', contour: 'wealth' }).maxDrawdownPct).toBeCloseTo(-25, 6);
  });

  it('«Всё время»: база нулевая, поток первого дня — весь стартовый капитал', () => {
    const perf = periodPerformance(series('portfolio'), { contour: 'wealth' });
    expect(perf.baseDate).toBeNull();
    expect(perf.startValueRub).toBe('0.00');
    // чистый ввод: 1 000 000 + 500 000 − 200 000
    expect(perf.netFlowRub).toBe(new Decimal(perf.endValueRub).minus(perf.resultRub).toFixed(2));
  });

  it('сумма результатов систем = результат портфеля (выплата без инструмента входит в свою систему)', () => {
    const bySystem = series('system');
    const whole = periodPerformance(series('portfolio'), { from: '2026-02-01', contour: 'wealth' });
    const keys = bySystem.groups.map((g) => g.key);
    expect(keys).toEqual(['s1', 's2']);
    const sum = keys.reduce(
      (acc, key) => acc.plus(periodPerformance(bySystem, { from: '2026-02-01', contour: 'positions', groupKey: key }).resultRub),
      new Decimal(0),
    );
    expect(sum.toFixed(2)).toBe(whole.resultRub);
    // и не зависит от способа группировки
    const byInstrument = periodPerformance(series('instrument'), { from: '2026-02-01', contour: 'wealth' });
    expect(byInstrument.resultRub).toBe(whole.resultRub);
  });

  it('контур позиций: поток группы = покупки − выручка продаж − выплаты', () => {
    // SBER за весь период: покупки 100×100 + 10×125, продажа 40×130, дивиденд 300
    const perf = periodPerformance(series('instrument'), { contour: 'positions', groupKey: 'SBER' });
    expect(perf.netFlowRub).toBe(new Decimal(10_000 + 1_250 - 5_200 - 300).toFixed(2));
    expect(perf.baseDate).toBeNull();
  });

  it('система только из фьючерсов: результат в ₽ есть, процентов нет — «нет капитала»', () => {
    const ops = [
      mk({ date: '2026-03-05', operationType: 'Buy', instrumentId: 'CNY-12.26', quantity: '2', price: '12000', systemId: 's9' }),
      mk({ date: '2026-03-23', operationType: 'Sell', instrumentId: 'CNY-12.26', quantity: '2', price: '12200', systemId: 's9' }),
    ];
    const s = valuationSeries(ops, [], { till: '2026-04-10', groupBy: 'system', futureIds: new Set(['CNY-12.26']) });
    const perf = periodPerformance(s, { contour: 'positions', groupKey: 's9' });
    expect(Number(perf.resultRub)).not.toBe(0);
    expect(perf.twr.pct).toBeNull();
    expect(perf.twr.reason).toBe('no-capital');
    expect(perf.mwr.pct).toBeNull();
    expect(perf.mwr.reason).toBe('no-capital');
  });

  it('система: комиссия до первой покупки не обнуляет TWR (регрессия: −100% навсегда)', () => {
    const ops = [
      mk({ date: '2026-02-02', operationType: 'Fee', quantity: '1', price: '1198' }), // издержка на системе без позиций
      mk({ date: '2026-02-04', operationType: 'Buy', instrumentId: 'SBER', quantity: '10', price: '100' }),
    ];
    const prices = [px('SBER', '2026-02-04', '100'), px('SBER', '2026-02-06', '110')];
    const s = valuationSeries(ops, prices, { till: '2026-02-06', groupBy: 'system', systemId: 's1' });
    const perf = periodPerformance(s, { contour: 'positions', groupKey: 's1' });
    expect(perf.twr.pct).toBeCloseTo(10, 6);
    expect(perf.twr.series.every((p) => p.index > 0)).toBe(true);
  });

  it('фьючерсная система с отрицательной «стоимостью» (убыток по открытой позиции): причина «нет капитала», а не «журнал неполон»', () => {
    const ops = [mk({ date: '2026-03-05', operationType: 'Buy', instrumentId: 'CNY-12.26', quantity: '2', price: '12000', systemId: 's9' })];
    const prices = [px('CNY-12.26', '2026-03-05', '12000'), px('CNY-12.26', '2026-03-09', '11000')];
    const s = valuationSeries(ops, prices, { till: '2026-03-12', groupBy: 'system', futureIds: new Set(['CNY-12.26']) });
    const perf = periodPerformance(s, { contour: 'positions', groupKey: 's9' });
    expect(Number(perf.endValueRub)).toBeLessThan(0); // «стоимость» фьючерса — переоценка, и она в минусе
    expect(perf.twr.pct).toBeNull();
    expect(perf.twr.reason).toBe('no-capital');
    expect(perf.mwr.reason).toBe('no-capital');
  });

  it('период без точек → no-data', () => {
    const perf = periodPerformance(series('portfolio'), { from: '2027-01-01', contour: 'wealth' });
    expect(perf.twr.reason).toBe('no-data');
    expect(perf.twr.series).toEqual([]);
  });
});


describe('periodPerformance: перевод денег и неполный журнал', () => {
  it('счёт, на который деньги пришли переводом: кэш не уходит в минус, доходность считается от внесённого', () => {
    const ops = [
      mk({ date: '2026-02-02', operationType: 'Transfer', quantity: '1', price: '1000', portfolioId: 'pB' }),
      mk({ date: '2026-02-02', operationType: 'Buy', instrumentId: 'SBER', quantity: '10', price: '100', portfolioId: 'pB' }),
    ];
    const prices = [px('SBER', '2026-02-02', '100'), px('SBER', '2026-02-03', '105'), px('SBER', '2026-02-04', '110'), px('SBER', '2026-02-05', '115')];
    const s = valuationSeries(ops, prices, { till: '2026-02-05', groupBy: 'instrument', portfolioId: 'pB' });
    const perf = periodPerformance(s, { contour: 'wealth' });
    expect(perf.resultRub).toBe('150.00');
    expect(perf.netFlowRub).toBe('1000.00');
    // до исправления: TWR +200% (капитал считался с нуля), Dietz — null
    expect(perf.twr.pct).toBeCloseTo(15, 6);
    expect(perf.dietzPct).not.toBeNull();
  });

  it('капитал контура уходил в минус (покупка без внесённых денег): проценты не показываются, ₽ верны', () => {
    const ops = [
      mk({ date: '2026-02-02', operationType: 'Buy', instrumentId: 'SBER', quantity: '10', price: '100', fee: '5' }),
      mk({ date: '2026-02-04', operationType: 'Deposit', price: '2000' }),
    ];
    const prices = [px('SBER', '2026-02-02', '100'), px('SBER', '2026-02-03', '110'), px('SBER', '2026-02-05', '120')];
    const s = valuationSeries(ops, prices, { till: '2026-02-05', groupBy: 'instrument' });
    const perf = periodPerformance(s, { contour: 'wealth' });
    expect(Number(perf.resultRub)).toBeGreaterThan(0);
    expect(perf.twr.pct).toBeNull();
    expect(perf.twr.reason).toBe('negative-capital');
    expect(perf.twr.series).toEqual([]);
    expect(perf.mwr.pct).toBeNull();
    expect(perf.mwr.reason).toBe('negative-capital');
    expect(perf.dietzPct).toBeNull();
    expect(perf.xirrPct).toBeNull();
  });

  it('копейки в минус после полного вывода (−402 ₽ при капитале в миллионы) проценты не обесценивают', () => {
    const f: PeriodFixture = {
      name: 'x',
      description: '',
      points: [
        { date: '2025-03-06', marketValueRub: 500_000, totalRub: 0, netContributionsRub: 500_000 },
        // выведено всё и ещё 402 ₽ комиссий сверху: богатство −402
        { date: '2025-03-07', marketValueRub: 0, totalRub: -402, netContributionsRub: 0 },
        { date: '2025-03-10', marketValueRub: 2_000_000, totalRub: -402, netContributionsRub: 2_000_000 },
        { date: '2025-12-31', marketValueRub: 2_200_000, totalRub: 199_598, netContributionsRub: 2_000_000 },
      ],
      expected: { resultRub: 0, twrIndex: 0, mwrPct: 0, mwrTolerancePp: 0 },
    };
    const perf = periodPerformance(seriesOf(f), { from: '2025-03-07', contour: 'wealth' });
    expect(perf.twr.reason).toBeNull();
    expect(perf.twr.pct).not.toBeNull();
  });

  it('нулевой капитал до первого ввода — норма, а не «отрицательный»: проценты считаются', () => {
    const ops = [
      mk({ date: '2026-02-03', operationType: 'Deposit', price: '1000' }),
      mk({ date: '2026-02-03', operationType: 'Buy', instrumentId: 'SBER', quantity: '10', price: '100' }),
    ];
    const prices = [px('SBER', '2026-02-03', '100'), px('SBER', '2026-02-05', '110')];
    const perf = periodPerformance(valuationSeries(ops, prices, { till: '2026-02-05', groupBy: 'instrument' }), { contour: 'wealth' });
    expect(perf.twr.pct).toBeCloseTo(10, 6);
    expect(perf.twr.reason).toBeNull();
  });
});
