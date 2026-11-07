import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { calculateTrades, type TradeResult } from './engine';
import { futureUnrealizedPnl } from './futures-engine';
import { absoluteDrawdown, outcomeStats, systemPerformance } from './performance';
import { tradeStats } from './metrics';
import { CNY_FUTURE_ID, CNY_OPS, cnyOperation } from './futures-report.fixture';
import { SystemPerformanceSchema } from './schemas';

const FUT = new Set([CNY_FUTURE_ID]);
const MARK = '12387'; // расчётная цена конца периода, ₽ за контракт

const unrealizedOf = (t: TradeResult) =>
  futureUnrealizedPnl({ quantity: t.quantity, avgBuyPrice: t.avgBuyPrice }, MARK);

describe('сделки движка: направление, время, комиссии', () => {
  const trades = calculateTrades(CNY_OPS, { futureIds: FUT });

  it('три цикла: лонг, шорт, шорт', () => {
    expect(trades.map((t) => t.direction)).toEqual(['Long', 'Short', 'Short']);
    expect(trades.map((t) => t.status)).toEqual(['Closed', 'Closed', 'Open']);
  });

  it('время открытия/закрытия берётся из executedAt', () => {
    expect([trades[0].openedTime, trades[0].closedTime]).toEqual(['13:40:00', '10:20:00']);
    expect([trades[1].openedTime, trades[1].closedTime]).toEqual(['13:00:03', '10:20:01']);
    expect([trades[2].openedTime, trades[2].closedTime]).toEqual(['13:00:04', null]);
  });

  it('комиссии по сделкам = факт отчёта: 19,30 / 632,16 / 311,45', () => {
    expect(trades.map((t) => t.feesRub.toFixed(2))).toEqual(['19.30', '632.16', '311.45']);
  });

  it('realizedPnlRub уже за вычетом комиссий: gross = net + fees', () => {
    expect(trades[0].realizedPnlRub.plus(trades[0].feesRub).toNumber()).toBe(204);
    expect(trades[1].realizedPnlRub.plus(trades[1].feesRub).toNumber()).toBe(-15405);
    expect(trades[0].realizedPnlRub.toFixed(2)).toBe('184.70');
    expect(trades[1].realizedPnlRub.toFixed(2)).toBe('-16037.16');
  });

  it('акции — всегда Long, комиссия покупки и продажи собирается в feesRub', () => {
    const [t] = calculateTrades([
      { date: '2026-01-10', systemId: 's', portfolioId: 'p', instrumentId: 'SBER', operationType: 'Buy', quantity: '10', price: '100', fee: '1.5', fxRate: '1', currency: 'RUB' },
      { date: '2026-01-12', systemId: 's', portfolioId: 'p', instrumentId: 'SBER', operationType: 'Sell', quantity: '10', price: '110', fee: '2', fxRate: '1', currency: 'RUB' },
    ]);
    expect(t.direction).toBe('Long');
    expect(t.feesRub.toString()).toBe('3.5');
    expect(t.realizedPnlRub.toString()).toBe('96.5'); // 1100−2 − (1000+1.5)
    expect([t.openedTime, t.closedTime]).toEqual([null, null]);
  });
});

describe('systemPerformance: эталон отчёта SESPS (CNY-12.26)', () => {
  const trades = calculateTrades(CNY_OPS, { futureIds: FUT });
  const p = systemPerformance(trades, { unrealizedOf });

  it('сверка с вариационной маржой отчёта: −15 405 + 204 + 4 288 = −10 913', () => {
    const sumGross = new Decimal(p.summary.grossPnlRub)
      .plus(p.summary.openRealizedRub)
      .plus(p.summary.feesTotalRub) // валовой результат открытой = realized + fees(открытой)
      .minus(p.summary.feesRub)
      .plus(p.summary.unrealizedRub);
    expect(sumGross.toFixed(2)).toBe('-10913.00');
  });

  it('итог: net закрытых −15 852,46; комиссии 962,91; нереализованный +4 288', () => {
    expect(p.summary.netPnlRub).toBe('-15852.46');
    expect(p.summary.grossPnlRub).toBe('-15201.00');
    expect(p.summary.feesRub).toBe('651.46');
    expect(p.summary.feesTotalRub).toBe('962.91');
    expect(p.summary.openRealizedRub).toBe('-311.45');
    expect(p.summary.unrealizedRub).toBe('4288.00');
    expect(p.summary.totalRub).toBe('-11875.91');
    expect(p.summary.openCount).toBe(1);
    expect(p.summary.feeSharePct).toBeNull(); // gross < 0
  });

  it('сделки: 2 закрытых, win rate 50 %, лонг 1/1, шорт 1/0', () => {
    expect(p.trades).toMatchObject({ closed: 2, wins: 1, losses: 1, breakeven: 0, winRatePct: 50 });
    expect(p.trades.long).toEqual({ count: 1, wins: 1, winRatePct: 100, netPnlRub: '184.70' });
    expect(p.trades.short).toEqual({ count: 1, wins: 0, winRatePct: 0, netPnlRub: '-16037.16' });
  });

  it('качество: profit factor, payoff, матожидание, крайние сделки', () => {
    const pf = 184.7 / 16037.16;
    expect(p.quality.profitFactor).toBeCloseTo(pf, 10);
    expect(p.quality.payoffRatio).toBeCloseTo(pf, 10); // по одной сделке каждого знака совпадает
    expect(p.quality.avgWinRub).toBe('184.70');
    expect(p.quality.avgLossRub).toBe('-16037.16');
    expect(p.quality.expectancyRub).toBe('-7926.23'); // −15852.46 / 2
    expect(p.quality.largestWinRub).toBe('184.70');
    expect(p.quality.largestLossRub).toBe('-16037.16');
  });

  it('серии: по одной прибыльной и убыточной, текущая — убыточная', () => {
    expect(p.streaks).toEqual({ maxWins: 1, maxLosses: 1, current: { kind: 'loss', length: 1 } });
  });

  it('просадка от пика +184,70 (30.10) до −15 852,46 (05.11): 16 037,16 ₽, не восстановлена', () => {
    expect(p.risk.maxDrawdownRub).toBe('16037.16');
    expect(p.risk.peakDate).toBe('2026-10-30');
    expect(p.risk.troughDate).toBe('2026-11-05');
    expect(p.risk.recoveryDate).toBeNull();
    expect(p.risk.drawdownDays).toBe(6);
    expect(p.risk.recoveryFactor).toBeCloseTo(-15852.46 / 16037.16, 10);
  });

  it('эквити: стартовый ноль, 30.10, 05.11 с просадкой', () => {
    expect(p.series.equity).toEqual([
      { date: '2026-10-29', equityRub: '0.00', drawdownRub: '0.00' },
      { date: '2026-10-30', equityRub: '184.70', drawdownRub: '0.00' },
      { date: '2026-11-05', equityRub: '-15852.46', drawdownRub: '-16037.16' },
    ]);
  });

  it('срок удержания считается по часам: лонг 20 ч 40 мин, шорт 20 ч 20 мин', () => {
    expect(p.holding.hasTime).toBe(true);
    const long = 20 + 40 / 60; // 29.10 13:40:00 → 30.10 10:20:00
    const short = (Date.parse('2026-11-05T10:20:01Z') - Date.parse('2026-11-04T13:00:03Z')) / 3_600_000;
    expect(p.holding.avgHours).toBeCloseTo((long + short) / 2, 8);
    expect(p.holding.avgWinHours).toBeCloseTo(long, 8);
    expect(p.holding.avgLossHours).toBeCloseTo(short, 8);
  });

  it('разрезы: по месяцам и дням недели (по дате закрытия)', () => {
    expect(p.series.byMonth).toEqual([
      { period: '2026-10', pnlRub: '184.70', trades: 1 },
      { period: '2026-11', pnlRub: '-16037.16', trades: 1 },
    ]);
    // 30.10.2026 — пятница (5), 05.11.2026 — четверг (4)
    expect(p.series.byWeekday).toEqual([
      { weekday: 4, pnlRub: '-16037.16', trades: 1 },
      { weekday: 5, pnlRub: '184.70', trades: 1 },
    ]);
    expect(p.series.histogram.reduce((s, b) => s + b.count, 0)).toBe(2);
  });

  it('DTO проходит схему контракта', () => {
    const dto = { systemId: 's1', systemName: 'ЮВ1', ...p };
    expect(() => SystemPerformanceSchema.parse(dto)).not.toThrow();
  });
});

describe('systemPerformance: цикл закрывается следующим импортом', () => {
  // выход цикла 2 из CSV QUIK: Buy 128 @ 12 405 (06.11 10:20) → (12 420,5 − 12 405) × 128 = +1 984 gross
  const exit = cnyOperation(['2026-11-06', '10:20:00', 'Buy', '128', '12405', '0', '1015'], 14);
  const trades = calculateTrades([...CNY_OPS, exit], { futureIds: FUT });
  const p = systemPerformance(trades, { unrealizedOf });

  it('третья сделка закрыта: gross +1 984, net = 1984 − 311,45 = +1 672,55', () => {
    expect(trades.map((t) => t.status)).toEqual(['Closed', 'Closed', 'Closed']);
    expect(trades[2].realizedPnlRub.toFixed(2)).toBe('1672.55');
    expect(trades[2].realizedPnlRub.plus(trades[2].feesRub).toNumber()).toBe(1984);
    expect(p.summary.openCount).toBe(0);
    expect(p.summary.unrealizedRub).toBe('0.00');
    expect(p.summary.netPnlRub).toBe('-14179.91');
  });

  it('статистика: 3 сделки, 2 прибыльных, серия, просадка неглубже и без восстановления', () => {
    expect(p.trades).toMatchObject({ closed: 3, wins: 2, losses: 1, winRatePct: (2 / 3) * 100 });
    expect(p.streaks).toEqual({ maxWins: 1, maxLosses: 1, current: { kind: 'win', length: 1 } });
    expect(p.risk.maxDrawdownRub).toBe('16037.16');
    expect(p.risk.recoveryDate).toBeNull();
    expect(p.holding.avgWinHours).toBeCloseTo(
      (20 + 40 / 60 + (Date.parse('2026-11-06T10:20:00Z') - Date.parse('2026-11-05T13:00:04Z')) / 3_600_000) / 2,
      8,
    );
  });
});

// ───────────────────────────── синтетические краевые случаи ─────────────────────────────

let seq = 0;
function trade(pnl: string, closedAt: string, over: Partial<TradeResult> = {}): TradeResult {
  seq++;
  return {
    instrumentId: 'X',
    systemId: 's1',
    portfolioId: 'p1',
    status: 'Closed',
    quantity: new Decimal(0),
    qtyBought: new Decimal(1),
    qtySold: new Decimal(1),
    avgBuyPrice: new Decimal(0),
    investedCcy: new Decimal(0),
    investedRub: new Decimal(0),
    proceedsCcy: new Decimal(0),
    proceedsRub: new Decimal(0),
    realizedPnlCcy: new Decimal(pnl),
    realizedPnlRub: new Decimal(pnl),
    dividendsRub: new Decimal(0),
    couponsRub: new Decimal(0),
    tradeCurrency: 'RUB',
    direction: 'Long',
    openedAt: closedAt,
    closedAt,
    openedTime: null,
    closedTime: null,
    feesRub: new Decimal(0),
    operationIds: [`o${seq}`],
    ...over,
  };
}

describe('systemPerformance: краевые случаи', () => {
  it('нет сделок → валидный DTO с нулями и пустыми рядами', () => {
    const p = systemPerformance([]);
    expect(p.summary.netPnlRub).toBe('0.00');
    expect(p.trades.closed).toBe(0);
    expect(p.trades.winRatePct).toBeNull();
    expect(p.quality.profitFactor).toBeNull();
    expect(p.risk).toMatchObject({ maxDrawdownRub: '0.00', peakDate: null, recoveryDate: null, drawdownDays: 0 });
    expect(p.series.equity).toEqual([]);
    expect(p.series.histogram).toEqual([]);
    expect(p.ratios.sharpe).toBeNull();
    expect(() => SystemPerformanceSchema.parse({ systemId: 's', systemName: 'S', ...p })).not.toThrow();
  });

  it('только прибыльные: profit factor и payoff не определены, просадки нет', () => {
    const p = systemPerformance([trade('100', '2026-01-05'), trade('50', '2026-01-06')]);
    expect(p.quality.profitFactor).toBeNull();
    expect(p.quality.payoffRatio).toBeNull();
    expect(p.trades.winRatePct).toBe(100);
    expect(p.risk.maxDrawdownRub).toBe('0.00');
    expect(p.risk.recoveryFactor).toBeNull();
    expect(p.streaks.maxWins).toBe(2);
  });

  it('только открытые: закрытой статистики нет, но открытый результат виден', () => {
    const open = trade('-10', '2026-01-05', { status: 'Open', closedAt: null, quantity: new Decimal(-2), feesRub: new Decimal(10) });
    const p = systemPerformance([open], { unrealizedOf: () => new Decimal(35) });
    expect(p.trades.closed).toBe(0);
    expect(p.summary).toMatchObject({ netPnlRub: '0.00', openRealizedRub: '-10.00', unrealizedRub: '35.00', totalRub: '25.00', openCount: 1 });
  });

  it('дивиденды и купоны входят в «Всего», но не в результат закрытых и не в нереализованный', () => {
    const open = trade('0', '2026-01-05', {
      status: 'Open',
      closedAt: null,
      dividendsRub: new Decimal(100),
      couponsRub: new Decimal(20),
    });
    const p = systemPerformance([open], { unrealizedOf: () => new Decimal(-50) });
    expect(p.summary).toMatchObject({ netPnlRub: '0.00', unrealizedRub: '-50.00', incomeRub: '120.00', openIncomeRub: '120.00', openResultRub: '70.00', totalRub: '70.00' });
  });

  it('открытая без оценки: нереализованный = 0, не падает', () => {
    const open = trade('0', '2026-01-05', { status: 'Partial', closedAt: null });
    expect(systemPerformance([open]).summary.unrealizedRub).toBe('0.00');
  });

  it('переворот лонг → шорт даёт две сделки с разным направлением', () => {
    const ops = [
      cnyOperation(['2026-11-01', '10:00:00', 'Buy', '3', '10000', '0', 'a1'], 0),
      cnyOperation(['2026-11-01', '11:00:00', 'Sell', '5', '10100', '0', 'a2'], 1),
      cnyOperation(['2026-11-02', '11:00:00', 'Buy', '2', '10050', '0', 'a3'], 2),
    ];
    const trades = calculateTrades(ops, { futureIds: FUT });
    expect(trades.map((t) => t.direction)).toEqual(['Long', 'Short']);
    const p = systemPerformance(trades);
    expect(p.trades.closed).toBe(2);
    expect(p.trades.long.netPnlRub).toBe('300.00');
    expect(p.trades.short.netPnlRub).toBe('100.00'); // (10100−10050)×2
  });

  it('серия убытков, прерываемая безубыточной сделкой', () => {
    const p = systemPerformance([
      trade('-10', '2026-02-02'),
      trade('-20', '2026-02-03'),
      trade('-5', '2026-02-04'),
      trade('0', '2026-02-05'),
      trade('-1', '2026-02-06'),
    ]);
    expect(p.streaks.maxLosses).toBe(3);
    expect(p.streaks.current).toEqual({ kind: 'loss', length: 1 });
    expect(p.trades.breakeven).toBe(1);
  });

  it('восстановление после просадки: дата восстановления и длительность', () => {
    const p = systemPerformance([
      trade('100', '2026-03-02'), // пик 100
      trade('-60', '2026-03-03'),
      trade('-40', '2026-03-04'), // дно 0, просадка 100
      trade('30', '2026-03-05'),
      trade('80', '2026-03-06'), // 110 ≥ 100 — восстановились
    ]);
    expect(p.risk.maxDrawdownRub).toBe('100.00');
    expect(p.risk.peakDate).toBe('2026-03-02');
    expect(p.risk.troughDate).toBe('2026-03-04');
    expect(p.risk.recoveryDate).toBe('2026-03-06');
    expect(p.risk.drawdownDays).toBe(4);
    expect(p.risk.recoveryFactor).toBeCloseTo(110 / 100, 10);
  });

  it('первая же сделка в минус — уже просадка от стартового нуля', () => {
    const p = systemPerformance([trade('-25', '2026-04-01')]);
    expect(p.risk.maxDrawdownRub).toBe('25.00');
    expect(p.series.equity[0]).toMatchObject({ equityRub: '0.00' });
  });

  it('без времени срок считается по датам и помечается hasTime=false', () => {
    const p = systemPerformance([trade('10', '2026-05-12', { openedAt: '2026-05-10' })]);
    expect(p.holding.hasTime).toBe(false);
    expect(p.holding.avgHours).toBe(48);
  });

  it('Sharpe/Sortino: будни без сделок дают нули, выходные не разбавляют', () => {
    // пн 02.03 +100, вт 03.03 0, ср 04.03 −50 → дневные [100, 0, −50]
    const p = systemPerformance([trade('100', '2026-03-02'), trade('-50', '2026-03-04')]);
    expect(p.ratios.days).toBe(3);
    const mu = 50 / 3;
    const sigma = Math.sqrt(((100 - mu) ** 2 + (0 - mu) ** 2 + (-50 - mu) ** 2) / 2);
    expect(p.ratios.sharpe).toBeCloseTo((mu / sigma) * Math.sqrt(252), 8);
    const dsd = Math.sqrt(50 ** 2 / 3);
    expect(p.ratios.sortino).toBeCloseTo((mu / dsd) * Math.sqrt(252), 8);
  });

  it('Sharpe не определён при одном дне и нулевом разбросе', () => {
    expect(systemPerformance([trade('10', '2026-03-02')]).ratios.sharpe).toBeNull();
    const flat = systemPerformance([trade('10', '2026-03-02'), trade('10', '2026-03-03')]);
    expect(flat.ratios.sharpe).toBeNull();
  });

  it('гистограмма: сделки распределены по интервалам, максимум попадает в последний', () => {
    const p = systemPerformance([trade('-100', '2026-06-01'), trade('0', '2026-06-02'), trade('100', '2026-06-03'), trade('100', '2026-06-04')]);
    expect(p.series.histogram.reduce((s, b) => s + b.count, 0)).toBe(4);
    expect(p.series.histogram[0].fromRub).toBe('-100.00');
    expect(p.series.histogram[p.series.histogram.length - 1].toRub).toBe('100.00');
  });
});

describe('единая формула win rate', () => {
  it('outcomeStats и tradeStats дают одни и те же числа', () => {
    const results = ['100', '-40', '0', '60'].map((x) => new Decimal(x));
    const o = outcomeStats(results);
    const s = tradeStats(
      results.map((r, i) => ({ status: 'Closed' as const, realizedPnlRub: r.toNumber(), openedAt: '2026-01-01', closedAt: `2026-01-0${i + 2}` })),
    );
    expect(s.winRatePct).toBe(o.winRatePct);
    expect(s.profitFactor).toBe(o.profitFactor);
    expect(s.winCount).toBe(o.wins);
    expect(o.winRatePct).toBe(50);
    expect(o.profitFactor).toBeCloseTo(4, 10);
  });

  it('absoluteDrawdown: ряд P&L с нуля', () => {
    const dd = absoluteDrawdown([0, 10, 4, 12, 3].map((x) => new Decimal(x)));
    expect(dd.maxDrawdown.toString()).toBe('9');
    expect([dd.peakIndex, dd.troughIndex, dd.recoveryIndex]).toEqual([3, 4, null]);
  });
});
