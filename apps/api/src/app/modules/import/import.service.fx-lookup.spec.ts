import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RawRow } from '@core';
import { instruments, operations, portfolios, systems } from '../../../db/schema';
import { InstrumentIdentityService } from '../instruments/instrument-identity.service';
import { ImportService } from './import.service';

/** Курс вывода валюты берётся из реальных сделок СВОЕГО счёта; синтетические :fx-операции курса не задают */
let db: BetterSQLite3Database;
let service: ImportService;

const buy = (id: string, portfolioId: string, price: string, transferGroup: string | null = null) =>
  db.insert(operations).values({ id, date: '2024-08-01', systemId: 's', portfolioId, instrumentId: 'CNYRUB_TOM', operationType: 'Buy', quantity: '100', price, fee: '0', fxRate: '1', currency: 'RUB', transferGroup }).run();

const withdraw = (accountRef: string): RawRow => ({
  date: '2024-08-01', currency: 'CNY', tradeType: 'withdraw', quantity: '1', price: '100', brokerRef: 'w1', accountRef,
});
const rateOf = (rows: RawRow[]) => rows.find((r) => r.tradeType === 'sell')?.price;

beforeEach(() => {
  const sqlite = new Database(':memory:');
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
  db = drizzle(sqlite);
  db.insert(systems).values({ id: 's', name: 'S' }).run();
  db.insert(portfolios).values([{ id: 'p1', name: 'A', accountRef: 'ACC1' }, { id: 'p2', name: 'B', accountRef: 'ACC2' }]).run();
  db.insert(instruments).values({ id: 'CNYRUB_TOM', ticker: 'CNYRUB_TOM', type: 'Currency', currency: 'RUB', marketSource: 'moex' }).run();
  service = new ImportService(db as never, new InstrumentIdentityService(db as never));
});

const expand = (accountRef: string) => {
  const id = service.stashRawRows([withdraw(accountRef)]);
  // стеш уже развернул строки; достаём результат через предпросмотр нельзя без разметки — читаем кэш
  return (service as unknown as { uploads: Map<string, { rows: RawRow[] }> }).uploads.get(id)!.rows;
};

describe('журнальный курс вывода валюты', () => {
  it('покупка своего счёта задаёт курс; покупка другого счёта — нет', () => {
    buy('b1', 'p1', '11.5');
    buy('b2', 'p2', '99');
    expect(rateOf(expand('ACC1'))).toBe('11.5');
  });

  it('синтетическая :fx-покупка ввода курса не задаёт: нет реальных покупок — курса нет (ЦБ тоже нет)', () => {
    buy('fx1', 'p1', '12.7965', 'fx:152368623547');
    const rows = expand('ACC1');
    expect(rows[0].skipReason).toMatch(/Нет курса CNY/);
  });

  it('синтетика не размывает курс реальной покупки', () => {
    buy('b1', 'p1', '11.5');
    buy('fx1', 'p1', '20', 'fx:1');
    expect(rateOf(expand('ACC1'))).toBe('11.5');
  });
});
