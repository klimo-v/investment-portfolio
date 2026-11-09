import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RawRow } from '@core';
import { operations, portfolios, systems } from '../../../db/schema';
import { InstrumentIdentityService } from '../instruments/instrument-identity.service';
import { ImportService } from './import.service';

/** Происхождение операции: заполняется при импорте, повторный импорт идемпотентен, дедупликация прежняя */
let db: BetterSQLite3Database;
let service: ImportService;
const opts = { systemId: 's', portfolioId: 'p' };
const row = (over: Partial<RawRow> = {}): RawRow => ({
  date: '2024-09-10', tradeType: 'Buy', currency: 'RUB', quantity: '10', price: '12.5', fee: '0',
  ticker: 'CNYRUB_TOM', instrumentType: 'Currency', brokerRef: 'n1', identifiers: { figi: 'BBG0013HRTL0' },
  ...over,
});
const stored = () => db.select().from(operations).where(eq(operations.brokerRef, 'n1')).get();

beforeEach(() => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
  db = drizzle(sqlite);
  db.insert(systems).values({ id: 's', name: 'S' }).run();
  db.insert(portfolios).values({ id: 'p', name: 'P' }).run();
  service = new ImportService(db, new InstrumentIdentityService(db));
});

describe('operations.source_code', () => {
  it('импорт записывает самый сильный код строки', async () => {
    await service.commit({ ...opts, uploadId: service.stashRawRows([row()]) });
    expect(stored()?.sourceCode).toBe('figi:BBG0013HRTL0');
  });

  it('повторный импорт того же — дубль, 0 обновлений', async () => {
    await service.commit({ ...opts, uploadId: service.stashRawRows([row()]) });
    const again = await service.commit({ ...opts, uploadId: service.stashRawRows([row()]) });
    expect(again).toMatchObject({ imported: 0, updated: 0 });
    expect(db.select().from(operations).all()).toHaveLength(1);
  });

  it('старая операция без кода: повторный импорт один раз заполняет пустое, потом идемпотентен; заполненное не меняется', async () => {
    await service.commit({ ...opts, uploadId: service.stashRawRows([row()]) });
    db.update(operations).set({ sourceCode: null }).where(eq(operations.brokerRef, 'n1')).run();

    const filled = await service.commit({ ...opts, uploadId: service.stashRawRows([row()]) });
    expect(filled).toMatchObject({ imported: 0, updated: 1 });
    expect(stored()?.sourceCode).toBe('figi:BBG0013HRTL0');

    const same = await service.commit({ ...opts, uploadId: service.stashRawRows([row()]) });
    expect(same).toMatchObject({ updated: 0 });
    // другой код при повторном импорте существующее значение не затирает
    const other = await service.commit({ ...opts, uploadId: service.stashRawRows([row({ identifiers: { figi: 'BBG0013HRTL0', tbankUid: 'u-1' } })]) });
    expect(other).toMatchObject({ updated: 0 });
    expect(stored()?.sourceCode).toBe('figi:BBG0013HRTL0');
  });

  it('ручная операция остаётся с null', () => {
    db.insert(operations).values({ id: 'm1', date: '2024-09-10', systemId: 's', portfolioId: 'p', operationType: 'Deposit', quantity: '1', price: '100', fee: '0', fxRate: '1', currency: 'RUB' }).run();
    expect(db.select().from(operations).get()?.sourceCode).toBeNull();
  });
});
