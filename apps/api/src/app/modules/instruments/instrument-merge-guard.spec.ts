import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { backfillInstrumentIdentifiers } from '../../../db/instrument-identifiers-store';
import { instruments, operations, portfolios, priceHistory, systems } from '../../../db/schema';
import { InstrumentIdentityService } from './instrument-identity.service';

/** Защита слияния: блокировка валютных пар, подтверждение предупреждений, проверки повторяются на сервере */
let db: BetterSQLite3Database;
let service: InstrumentIdentityService;

const addInstrument = (id: string, ticker: string, extra: Partial<typeof instruments.$inferInsert> = {}) =>
  db.insert(instruments).values({ id, ticker, type: 'Currency', currency: 'RUB', marketSource: 'moex', ...extra }).run();
const addOp = (instrumentId: string, price: string, currency = 'RUB') =>
  db
    .insert(operations)
    .values({ id: `op-${instrumentId}-${price}`, date: '2024-08-01', systemId: 's', portfolioId: 'p', instrumentId, operationType: 'Buy', quantity: '10', price, fee: '0', fxRate: '1', currency })
    .run();

beforeEach(() => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
  db = drizzle(sqlite);
  db.insert(systems).values({ id: 's', name: 'S' }).run();
  db.insert(portfolios).values({ id: 'p', name: 'P' }).run();
  service = new InstrumentIdentityService(db as never);
});

describe('защита слияния', () => {
  it('CNYRUB_TOM → GLDRUB_TOM блокируется, даже с confirmWarnings; ничего не меняется', () => {
    addInstrument('CNY', 'CNYRUB_TOM');
    addInstrument('GLD', 'GLDRUB_TOM');
    addOp('CNY', '12.3');
    backfillInstrumentIdentifiers(db as never);
    expect(() => service.merge('CNY', 'GLD', { confirmWarnings: true })).toThrow(/запрещено/);
    expect(db.select().from(instruments).all()).toHaveLength(2);
    expect(db.select().from(operations).where(eq(operations.instrumentId, 'CNY')).all()).toHaveLength(1);
    expect(service.mergePreview('CNY', 'GLD').blockers).toHaveLength(1);
  });

  it('TMON@ → TMON проходит без подтверждения', () => {
    addInstrument('TMON@', 'TMON@', { type: 'Fund' });
    addInstrument('TMON', 'TMON', { type: 'Fund' });
    addOp('TMON@', '7');
    backfillInstrumentIdentifiers(db as never);
    expect(service.merge('TMON@', 'TMON')).toMatchObject({ merged: true, movedOperations: 1 });
  });

  it('TCS00A10B4K3 → RU000A10B4K3 проходит без подтверждения', () => {
    addInstrument('TCS00A10B4K3', 'TCS00A10B4K3', { type: 'Bond' });
    addInstrument('RU000A10B4K3', 'RU000A10B4K3', { type: 'Bond', isin: 'RU000A10B4K3' });
    backfillInstrumentIdentifiers(db as never);
    expect(service.mergePreview('TCS00A10B4K3', 'RU000A10B4K3')).toMatchObject({ blockers: [], warnings: [] });
    expect(service.merge('TCS00A10B4K3', 'RU000A10B4K3').merged).toBe(true);
  });

  it('предупреждение требует confirmWarnings: без него 400 и ничего не слито', () => {
    addInstrument('SBERP', 'SBERP', { type: 'Stock' });
    addInstrument('SBER', 'SBER', { type: 'Stock' });
    backfillInstrumentIdentifiers(db as never);
    expect(() => service.merge('SBERP', 'SBER')).toThrow(/подтверждения/);
    expect(db.select().from(instruments).all()).toHaveLength(2);
    expect(service.merge('SBERP', 'SBER', { confirmWarnings: true }).merged).toBe(true);
  });

  it('расхождение цен (сделки по 12, цена цели 10 000) — предупреждение; USD-облигация (другая валюта цены) — нет', () => {
    addInstrument('A', 'AAA', { type: 'Stock' });
    addInstrument('B', 'BBB', { type: 'Stock' });
    addOp('A', '12');
    db.insert(priceHistory).values({ instrumentId: 'B', date: '2024-07-30', price: '10000', currency: 'RUB', source: 'moex' }).run();
    expect(service.mergePreview('A', 'B').warnings.map((w) => w.code)).toContain('price-divergence');

    addInstrument('C', 'CCC', { type: 'Bond' });
    addInstrument('D', 'CCC1', { type: 'Bond' });
    addOp('C', '84', 'RUB');
    db.insert(priceHistory).values({ instrumentId: 'D', date: '2024-07-30', price: '1', currency: 'USD', source: 'moex' }).run();
    expect(service.mergePreview('C', 'D').warnings.map((w) => w.code)).not.toContain('price-divergence');
  });

  it('preview считает последствия', () => {
    addInstrument('A', 'AAA', { type: 'Stock' });
    addInstrument('B', 'AAA2', { type: 'Stock' });
    addOp('A', '10');
    backfillInstrumentIdentifiers(db as never);
    expect(service.mergePreview('A', 'B').consequences).toMatchObject({ operations: 1, codes: 1 });
  });
});
