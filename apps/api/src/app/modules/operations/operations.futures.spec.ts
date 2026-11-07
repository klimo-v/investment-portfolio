import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { instruments, operations, portfolios, quotes, systems } from '../../../db/schema';
import type { QuotesService } from '../quotes/quotes.service';
import { PriceHistoryService } from '../quotes/price-history.service';
import { ValuationService } from '../valuation/valuation.service';
import { OperationsService } from './operations.service';

/**
 * Фьючерс CNY-12.26 на 14 сделках отчёта SESPS 27.10–05.11.2026 (цены ×1000, комиссии
 * брокер+биржа). Эталон — вариационная маржа отчёта: 204,00 − 11 117,00 = −10 913 ₽
 * (по цене сделок и расчётной 12 387), плюс комиссии 962,91 ₽ учтены отдельно.
 */
const quotesStub = { getFxRate: async () => 1, getFxRateOrNull: async () => 1 } as unknown as QuotesService;

type T = [date: string, time: string, side: 'Buy' | 'Sell', qty: string, price: string, fee: string, ref: string];
const TRADES: T[] = [
  ['2026-10-29', '13:40:00', 'Buy', '2', '12270', '4.81', '1001'],
  ['2026-10-29', '15:00:02', 'Buy', '2', '12284', '4.81', '1002'],
  ['2026-10-30', '10:20:00', 'Sell', '4', '12328', '9.68', '1003'],
  ['2026-11-04', '13:00:03', 'Sell', '4', '12357', '9.70', '1004'],
  ['2026-11-04', '13:00:03', 'Sell', '3', '12357', '7.28', '1005'],
  ['2026-11-04', '13:00:03', 'Sell', '58', '12357', '140.57', '1006'],
  ['2026-11-04', '15:00:02', 'Sell', '65', '12340', '157.37', '1007'],
  ['2026-11-05', '10:20:01', 'Buy', '81', '12467', '197.65', '1008'],
  ['2026-11-05', '10:20:01', 'Buy', '25', '12467', '61.01', '1009'],
  ['2026-11-05', '10:20:01', 'Buy', '20', '12467', '48.81', '1010'],
  ['2026-11-05', '10:20:01', 'Buy', '4', '12467', '9.77', '1011'],
  ['2026-11-05', '13:00:04', 'Sell', '64', '12421', '155.73', '1012'],
  ['2026-11-05', '15:00:03', 'Sell', '52', '12420', '126.52', '1013'],
  ['2026-11-05', '15:00:03', 'Sell', '12', '12420', '29.20', '1014'],
];
const FEES = TRADES.reduce((s, t) => s + Number(t[5]), 0); // 962.91

describe('OperationsService — фьючерсы', () => {
  let db: BetterSQLite3Database;
  let service: OperationsService;

  beforeEach(() => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
    db = drizzle(sqlite);
    db.insert(systems).values({ id: 'sys', name: 'Система' }).run();
    db.insert(portfolios).values({ id: 'pf', name: 'ИИС' }).run();
    db.insert(instruments)
      .values([
        { id: 'CNY-12.26', ticker: 'CNY-12.26', type: 'Future', currency: 'RUB', marketSource: 'manual' },
        { id: 'SBER', ticker: 'SBER', type: 'Stock', currency: 'RUB', marketSource: 'moex' },
      ])
      .run();
    db.insert(quotes)
      .values({ instrumentId: 'CNY-12.26', price: '12387', currency: 'RUB', source: 'manual', asOf: '2026-11-05T00:00:00.000Z' })
      .run();
    // пополнение 100 000 и покупка акций для проверки «ROI/XIRR без фьючерсов»
    db.insert(operations)
      .values([
        { id: randomUUID(), date: '2026-10-01', systemId: 'sys', portfolioId: 'pf', operationType: 'Deposit', quantity: '1', price: '100000', currency: 'RUB' },
      ])
      .run();
    db.insert(operations)
      .values(
        TRADES.map((t) => ({
          id: randomUUID(),
          date: t[0],
          executedAt: t[1],
          systemId: 'sys',
          portfolioId: 'pf',
          instrumentId: 'CNY-12.26',
          operationType: t[2],
          quantity: t[3],
          price: t[4],
          fee: t[5],
          currency: 'RUB',
          brokerRef: t[6],
        })),
      )
      .run();
    service = new OperationsService(db, quotesStub);
  });

  it('positions(): шорт −128, средняя 12 420,50, «вложено» 0, стоимость = нереализованный (+4 288)', async () => {
    const [p] = await service.positions();
    expect(p).toMatchObject({ ticker: 'CNY-12.26', type: 'Future', quantity: '-128', avgBuyPrice: '12420.50', investedRub: '0.00' });
    expect(Number(p.currentValueRub)).toBeCloseTo(4288, 0);
    expect(p.currentPrice).toBe('12387');
    expect(p.priceCurrency).toBe('RUB');
    // pnl = реализованный (по цене − комиссии) + нереализованный = −10 913 − 962.91
    expect(Number(p.pnlRub)).toBeCloseTo(-10913 - FEES, 0);
  });

  it('positions(): без расчётной цены у открытой позиции P&L неизвестен (null), а не ноль', async () => {
    db.delete(quotes).run();
    const [p] = await service.positions();
    expect(p.currentValueRub).toBeNull();
    expect(p.pnlRub).toBeNull();
  });

  it('trades(): три сделки, открытая оценена по расчётной цене', async () => {
    const trades = await service.trades();
    expect(trades.map((t) => t.status)).toEqual(['Closed', 'Closed', 'Open']);
    const open = trades[2];
    expect(open.quantity).toBe('-128');
    expect(Number(open.currentValueRub)).toBeCloseTo(4288, 0);
    const total = trades.reduce((s, t) => s + Number(t.pnlRub), 0);
    expect(total).toBeCloseTo(-10913 - FEES, 0);
  });

  it('summary(): P&L = ВМ отчёта минус комиссии; деньги = вклад + реализованный; ROI не считается', async () => {
    const s = await service.summary();
    expect(s.totals.pnlRub).toBeCloseTo(-10913 - FEES, 0);
    expect(s.totals.investedRub).toBe(0);
    expect(s.totals.unrealizedPnlRub).toBeCloseTo(4288, 0);
    // деньги: 100 000 + реализованный (−15 201 − 962.91), без «купил-заплатил» по сумме контрактов
    expect(s.cash.cashRub).toBeCloseTo(100000 - 15201 - FEES, 0);
    // всего в портфеле = деньги + стоимость (нереализованный)
    expect(s.cash.totalValueRub).toBeCloseTo(100000 - 10913 - FEES, 0);
    expect(s.totals.roiPct).toBeNull(); // вложено 0 → ROI не определён
    expect(s.totals.xirrPct).toBeNull(); // фьючерсы вне XIRR
    expect(s.breakdown.find((b) => b.ticker === 'CNY-12.26')?.pnlRub).toBeCloseTo(-10913 - FEES, 0);
  });

  it('summary(): ROI акций не искажается результатом фьючерса', async () => {
    db.insert(operations)
      .values({ id: randomUUID(), date: '2026-10-02', systemId: 'sys', portfolioId: 'pf', instrumentId: 'SBER', operationType: 'Buy', quantity: '10', price: '100', currency: 'RUB' })
      .run();
    db.insert(quotes).values({ instrumentId: 'SBER', price: '110', currency: 'RUB', source: 'moex', asOf: '2026-11-05T00:00:00.000Z' }).run();
    const s = await service.summary();
    expect(s.totals.investedRub).toBe(1000);
    expect(s.totals.roiPct).toBeCloseTo(10, 6); // (+100 по акциям) / 1000, фьючерс не входит
    expect(s.totals.pnlRub).toBeCloseTo(100 - 10913 - FEES, 0); // но в P&L фьючерс есть
  });

  it('summary(): период 05.11 — реализованный только от сделок периода', async () => {
    const all = await service.summary();
    const day = await service.summary({ from: '2026-11-05' });
    const before = await service.summary({ till: '2026-11-04' });
    expect(day.totals.realizedPnlRub + before.totals.realizedPnlRub).toBeCloseTo(all.totals.realizedPnlRub, 2);
  });

  it('дневной ряд: фьючерс оценён нереализованным результатом (вложено 0), обычная позиция — рыночной стоимостью', async () => {
    db.insert(operations)
      .values({ id: randomUUID(), date: '2026-10-02', systemId: 'sys', portfolioId: 'pf', instrumentId: 'SBER', operationType: 'Buy', quantity: '10', price: '100', currency: 'RUB' })
      .run();
    db.insert(quotes).values({ instrumentId: 'SBER', price: '110', currency: 'RUB', source: 'moex', asOf: '2026-11-05T00:00:00.000Z' }).run();
    const valuation = new ValuationService(db, service, new PriceHistoryService(db, []), quotesStub);
    const series = await valuation.series({ groupBy: 'instrument' });
    const last = (key: string) => series.groups.find((g) => g.key === key)!.points.at(-1)!;
    expect(last('SBER')).toMatchObject({ marketValueRub: '1100.00', investedRub: '1000.00', unrealizedRub: '100.00' });
    expect(last('CNY-12.26')).toMatchObject({ marketValueRub: '4288.00', investedRub: '0.00' });
  });
});
