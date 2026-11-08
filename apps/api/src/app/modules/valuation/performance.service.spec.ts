import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { PerformanceQuerySchema } from '@core';
import { instruments, operations, portfolios, priceHistory, systems } from '../../../db/schema';
import { OperationsService } from '../operations/operations.service';
import { PriceHistoryService } from '../quotes/price-history.service';
import type { QuotesService } from '../quotes/quotes.service';
import { PerformanceService } from './performance.service';
import { ValuationService } from './valuation.service';

const quotesStub = { getFxRate: async () => 1, getFxRateOrNull: async () => 1 } as unknown as QuotesService;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

let db: BetterSQLite3Database;
let service: PerformanceService;

function op(o: { date: string; type: string; system?: string; portfolio?: string; instrument?: string | null; qty?: string; price?: string }) {
  db.insert(operations)
    .values({
      id: randomUUID(),
      date: o.date,
      systemId: o.system ?? 's1',
      portfolioId: o.portfolio ?? 'p1',
      instrumentId: o.instrument === undefined ? 'SBER' : o.instrument,
      operationType: o.type,
      quantity: o.qty ?? '1',
      price: o.price ?? '0',
      currency: 'RUB',
    })
    .run();
}

beforeEach(() => {
  const sqlite = new Database(':memory:');
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
  db = drizzle(sqlite);
  db.insert(systems).values([{ id: 's1', name: 'Ядро' }, { id: 's2', name: 'Тактика' }]).run();
  db.insert(portfolios).values([{ id: 'p1', name: 'Счёт 1' }, { id: 'p2', name: 'Счёт 2' }]).run();
  db.insert(instruments)
    .values([
      { id: 'SBER', ticker: 'SBER', type: 'Stock', currency: 'RUB', marketSource: 'manual' },
      { id: 'GAZP', ticker: 'GAZP', type: 'Stock', currency: 'RUB', marketSource: 'manual' },
    ])
    .run();
  // счёт 1 / система «Ядро»: ввод 100 000, покупка SBER; счёт 2 / «Тактика»: ввод 50 000, покупка GAZP
  op({ date: day(-30), type: 'Deposit', instrument: null, price: '100000' });
  op({ date: day(-29), type: 'Buy', qty: '100', price: '100' });
  op({ date: day(-30), type: 'Deposit', instrument: null, price: '50000', system: 's2', portfolio: 'p2' });
  op({ date: day(-29), type: 'Buy', instrument: 'GAZP', qty: '50', price: '200', system: 's2', portfolio: 'p2' });
  op({ date: day(-10), type: 'Dividend', qty: '1', price: '500' });
  const px = (id: string, date: string, price: string) =>
    db.insert(priceHistory).values({ instrumentId: id, date, price, currency: 'RUB', source: 'moex' }).run();
  px('SBER', day(-29), '100');
  px('SBER', day(-5), '110');
  px('GAZP', day(-29), '200');
  px('GAZP', day(-5), '190');
  const ops = new OperationsService(db, quotesStub);
  const valuation = new ValuationService(db, ops, new PriceHistoryService(db, []), quotesStub);
  service = new PerformanceService(db, valuation, ops);
});

describe('PerformanceService: единый DTO периода', () => {
  it('«Всё время»: результат = переоценка + выплаты; TWR карточки = последняя точка ряда индекса', async () => {
    const dto = await service.performance({ scope: 'all' });
    // SBER +10×100 = +1 000, GAZP −10×50 = −500, дивиденд +500
    expect(dto.total.resultRub).toBe('1000.00');
    expect(dto.total.breakdown.payoutsRub).toBe('500.00');
    const series = dto.total.twr.series;
    expect(series[series.length - 1].index - 100).toBeCloseTo(dto.total.twr.pct as number, 10);
    expect(dto.total.contour).toBe('wealth');
  });

  it('сумма результатов по системам и по портфелям = результат всего журнала', async () => {
    const dto = await service.performance({ scope: 'all' });
    const sum = (rows: { performance: { resultRub: string } }[]) =>
      rows.reduce((s, r) => s.plus(r.performance.resultRub), new Decimal(0)).toFixed(2);
    expect(dto.bySystem.map((r) => r.name)).toEqual(['Ядро', 'Тактика']);
    expect(dto.byPortfolio.map((r) => r.name)).toEqual(['Счёт 1', 'Счёт 2']);
    expect(sum(dto.bySystem)).toBe(dto.total.resultRub);
    expect(sum(dto.byPortfolio)).toBe(dto.total.resultRub);
  });

  it('период внутри истории: база по рынку на день до from, а не по себестоимости', async () => {
    const dto = await service.performance({ scope: 'all', from: day(-6) });
    expect(dto.total.baseDate).toBe(day(-7));
    // на базе (day-7) SBER стоит 10 000, GAZP 10 000, кэш: 150 000 − 10 000 − 10 000 + 500 → V = 150 500
    expect(dto.total.startValueRub).toBe('150500.00');
    // за период: SBER +1 000, GAZP −500
    expect(dto.total.resultRub).toBe('500.00');
  });

  it('scope=system — контур позиций; scope=portfolio — свой кэш (wealth)', async () => {
    const sys = await service.performance({ scope: 'system', id: 's1' });
    expect(sys.total.contour).toBe('positions');
    expect(sys.bySystem.map((r) => r.id)).toEqual(['s1']);
    const pf = await service.performance({ scope: 'portfolio', id: 'p2' });
    expect(pf.total.contour).toBe('wealth');
    expect(pf.total.resultRub).toBe('-500.00');
  });

  it('валидация запроса: scope без id и перевёрнутый период отклоняются', () => {
    expect(PerformanceQuerySchema.safeParse({ scope: 'system' }).success).toBe(false);
    expect(PerformanceQuerySchema.safeParse({ scope: 'all', from: '2026-02-01', till: '2026-01-01' }).success).toBe(false);
    expect(PerformanceQuerySchema.safeParse({}).success).toBe(true);
  });
});
