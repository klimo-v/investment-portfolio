import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { operations, portfolios, strategyConfigs, strategyDailyResults, systems } from '../../../db/schema';
import type { QuotesService } from '../quotes/quotes.service';
import { OperationsService } from './operations.service';

/**
 * Срочная стратегия живёт вне `operations`: её реализованный net приходит лентой
 * `strategy_daily_results` и должен попадать в P&L системы, портфеля, итоги и свободные деньги.
 */

const quotesStub = { getFxRate: async () => 1 } as unknown as QuotesService;

describe('OperationsService.summary — лента результата стратегий', () => {
  let db: BetterSQLite3Database;
  let service: OperationsService;

  const addResult = (systemId: string, date: string, netRub: string): void => {
    db.insert(strategyDailyResults)
      .values({ systemId, date, pricePnlRub: netRub, costsRub: '0', debtInterestRub: '0', netRub, cycles: 1 })
      .run();
  };

  beforeEach(() => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
    db = drizzle(sqlite);
    db.insert(portfolios).values([
      { id: 'p1', name: 'Trader' },
      { id: 'p2', name: 'Другой' },
    ]).run();
    db.insert(systems).values([
      { id: 'spot', name: 'Спот' },
      { id: 'fut', name: 'Срочная' },
      { id: 'fut2', name: 'Срочная без счёта' },
    ]).run();
    db.insert(strategyConfigs).values([
      { systemId: 'fut', portfolioId: 'p1', adapter: 'quik-bridge' },
      { systemId: 'fut2', portfolioId: null, adapter: 'quik-bridge' },
    ]).run();
    db.insert(operations)
      .values({
        id: randomUUID(),
        date: '2026-10-01',
        systemId: 'spot',
        portfolioId: 'p1',
        operationType: 'Deposit',
        quantity: '100000',
        price: '1',
        currency: 'RUB',
      })
      .run();
    addResult('fut', '2026-11-06', '774.20');
    addResult('fut', '2026-11-09', '-100.00');
    service = new OperationsService(db, quotesStub);
  });

  it('net стратегии входит в «Реализ.», P&L, свободные деньги, систему и портфель', async () => {
    const s = await service.summary();
    expect(s.totals.realizedPnlRub).toBeCloseTo(674.2, 2);
    expect(s.totals.pnlRub).toBeCloseTo(674.2, 2);
    expect(s.cash.cashRub).toBeCloseTo(100674.2, 2);
    expect(s.bySystem.find((x) => x.systemId === 'fut')?.pnlRub).toBeCloseTo(674.2, 2);
    expect(s.byPortfolio.find((x) => x.portfolioId === 'p1')?.pnlRub).toBeCloseTo(674.2, 2);
  });

  it('период сужает «Реализ.», но не свободные деньги (остаток — величина на момент)', async () => {
    const s = await service.summary({ from: '2026-11-08' });
    expect(s.totals.realizedPnlRub).toBeCloseTo(-100, 2);
    expect(s.cash.cashRub).toBeCloseTo(100674.2, 2);
  });

  it('till отсекает более поздние дни и из P&L, и из денег', async () => {
    const s = await service.summary({ till: '2026-11-06' });
    expect(s.totals.pnlRub).toBeCloseTo(774.2, 2);
    expect(s.cash.cashRub).toBeCloseTo(100774.2, 2);
  });

  it('фильтр по системе и по портфелю', async () => {
    expect((await service.summary({ systemId: 'spot' })).totals.pnlRub).toBe(0);
    expect((await service.summary({ systemId: 'fut' })).totals.pnlRub).toBeCloseTo(674.2, 2);
    expect((await service.summary({ portfolioId: 'p2' })).totals.pnlRub).toBe(0);
    expect((await service.summary({ portfolioId: 'p1' })).totals.pnlRub).toBeCloseTo(674.2, 2);
  });

  it('стратегия без привязанного портфеля: в итогах есть, в портфелях и под фильтром портфеля — нет', async () => {
    addResult('fut2', '2026-11-07', '50.00');
    const all = await service.summary();
    expect(all.totals.pnlRub).toBeCloseTo(724.2, 2);
    expect(all.bySystem.some((x) => x.systemId === 'fut2')).toBe(true);
    expect(all.byPortfolio.map((x) => x.portfolioId)).toEqual(['p1']);
    expect((await service.summary({ portfolioId: 'p1' })).totals.pnlRub).toBeCloseTo(674.2, 2);
  });

  it('без ленты поведение прежнее: только операции', async () => {
    db.delete(strategyDailyResults).run();
    const s = await service.summary();
    expect(s.totals.pnlRub).toBe(0);
    expect(s.cash.cashRub).toBe(100000);
  });
});
