import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RawRow } from '@core';
import { backfillInstrumentIdentifiers } from '../../../db/instrument-identifiers-store';
import { instrumentHistory, instrumentIdentifiers, instruments, operations, portfolios, priceHistory, systems } from '../../../db/schema';
import { ImportService } from '../import/import.service';
import { InstrumentIdentityService } from './instrument-identity.service';

/** Разделение: сценарий CNY/GLD (юань, слитый в золото) на синтетических данных */
let sqlite: Database.Database;
let db: BetterSQLite3Database;
let identity: InstrumentIdentityService;

const newCny = { id: 'CNYRUB_TOM', ticker: 'CNYRUB_TOM', type: 'Currency', currency: 'RUB', name: 'Китайский юань', marketSource: 'moex' };
const request = (over: Record<string, unknown> = {}) => ({
  newInstrument: newCny,
  operationIds: ['b1', 'b2'],
  identifierKeys: ['ticker:CNYRUB_TOM', 'figi:BBG0013HRTL0'],
  fieldPatches: { name: 'Золото' },
  ...over,
});

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
  db = drizzle(sqlite);
  db.insert(systems).values({ id: 's', name: 'S' }).run();
  db.insert(portfolios).values({ id: 'p', name: 'P' }).run();
  // состояние после ошибочного слияния: у «золота» имя юаня, операции юаневые, цены золотые
  db.insert(instruments).values({ id: 'GLDRUB_TOM', ticker: 'GLDRUB_TOM', type: 'Currency', currency: 'RUB', name: 'CNYRUB_TOM', marketSource: 'moex' }).run();
  for (const [id, price] of [['b1', '11.78'], ['b2', '12.1']])
    db.insert(operations).values({ id, date: '2024-08-01', systemId: 's', portfolioId: 'p', instrumentId: 'GLDRUB_TOM', operationType: 'Buy', quantity: '100', price, fee: '0', fxRate: '1', currency: 'RUB' }).run();
  db.insert(priceHistory).values({ instrumentId: 'GLDRUB_TOM', date: '2024-08-01', price: '8102', currency: 'RUB', source: 'moex' }).run();
  backfillInstrumentIdentifiers(db as never);
  const ins = (scheme: string, value: string, origin = 'merge') =>
    db.insert(instrumentIdentifiers).values({ scheme: scheme as never, value, instrumentId: 'GLDRUB_TOM', origin: origin as never }).run();
  ins('ticker', 'CNYRUB_TOM');
  ins('figi', 'BBG0013HRTL0');
  ins('tbank_uid', '6e9d40d6-201f-45ac-9833-18dd40a09d33');
  identity = new InstrumentIdentityService(db as never);
});

const owner = (scheme: string, value: string) =>
  db.select().from(instrumentIdentifiers).all().find((e) => e.scheme === scheme && e.value === value)?.instrumentId;

describe('разделение инструмента', () => {
  it('переносит операции и выбранные коды, поправляет поля остающегося, пишет событие split', () => {
    const res = identity.split('GLDRUB_TOM', request());
    expect(res).toMatchObject({ newInstrumentId: 'CNYRUB_TOM', movedOperations: 2 });
    expect(db.select().from(operations).all().map((o) => o.instrumentId)).toEqual(['CNYRUB_TOM', 'CNYRUB_TOM']);
    expect(owner('ticker', 'CNYRUB_TOM')).toBe('CNYRUB_TOM');
    expect(owner('figi', 'BBG0013HRTL0')).toBe('CNYRUB_TOM');
    expect(owner('ticker', 'GLDRUB_TOM')).toBe('GLDRUB_TOM');
    // неполный выбор кодов: tbank_uid остался у исходного
    expect(owner('tbank_uid', '6e9d40d6-201f-45ac-9833-18dd40a09d33')).toBe('GLDRUB_TOM');
    expect(db.select().from(instruments).where(eq(instruments.id, 'GLDRUB_TOM')).get()?.name).toBe('Золото');
    // цены остаются у исходного
    expect(db.select().from(priceHistory).all().map((p) => p.instrumentId)).toEqual(['GLDRUB_TOM']);
    const [ev] = db.select().from(instrumentHistory).all();
    expect(ev).toMatchObject({ kind: 'split', sourceId: 'GLDRUB_TOM', targetId: 'CNYRUB_TOM' });
  });

  it('предпросмотр ничего не пишет и показывает обе стороны', () => {
    const plan = identity.splitPreview('GLDRUB_TOM', request());
    expect(plan.errors).toEqual([]);
    expect(plan.preview.created.positions[0]).toMatchObject({ quantity: '200' });
    expect(db.select().from(instruments).all()).toHaveLength(1);
  });

  it('ошибки: занятый id, чужая операция, пустой выбор, чужой код — ничего не меняется', () => {
    expect(() => identity.split('GLDRUB_TOM', request({ newInstrument: { ...newCny, id: 'GLDRUB_TOM' } }))).toThrow(/занят/);
    expect(() => identity.split('GLDRUB_TOM', request({ operationIds: ['nope'] }))).toThrow(/не принадлежат/);
    expect(() => identity.split('GLDRUB_TOM', request({ operationIds: [] }))).toThrow(/Не выбрано/);
    expect(() => identity.split('GLDRUB_TOM', request({ identifierKeys: ['ticker:NOPE'] }))).toThrow(/Коды не принадлежат/);
    expect(db.select().from(instruments).all()).toHaveLength(1);
    expect(db.select().from(instrumentHistory).all()).toHaveLength(0);
  });

  it('продажа без позиции требует подтверждения', () => {
    db.insert(operations).values({ id: 's1', date: '2024-09-04', systemId: 's', portfolioId: 'p', instrumentId: 'GLDRUB_TOM', operationType: 'Sell', quantity: '50', price: '12', fee: '0', fxRate: '1', currency: 'RUB' }).run();
    expect(() => identity.split('GLDRUB_TOM', request({ operationIds: ['s1'] }))).toThrow(/confirmOrphanSells/);
    expect(identity.split('GLDRUB_TOM', request({ operationIds: ['s1'], confirmOrphanSells: true })).movedOperations).toBe(1);
  });

  it('транзакционность: сбой посреди разделения откатывает всё', () => {
    sqlite.exec(`CREATE TRIGGER stop_hist BEFORE INSERT ON instrument_history BEGIN SELECT RAISE(ABORT, 'нельзя'); END;`);
    expect(() => identity.split('GLDRUB_TOM', request())).toThrow();
    expect(db.select().from(instruments).all().map((i) => i.id)).toEqual(['GLDRUB_TOM']);
    expect(db.select().from(operations).all().every((o) => o.instrumentId === 'GLDRUB_TOM')).toBe(true);
    expect(owner('ticker', 'CNYRUB_TOM')).toBe('GLDRUB_TOM');
  });

  it('повторный импорт после разделения попадает в новый инструмент по перенесённым кодам', async () => {
    identity.split('GLDRUB_TOM', request());
    const service = new ImportService(db as never, identity);
    const row: RawRow = {
      date: '2024-09-10', tradeType: 'Buy', currency: 'RUB', quantity: '10', price: '12.5', fee: '0',
      ticker: 'CNYRUB_TOM', instrumentType: 'Currency', brokerRef: 'n1', identifiers: { figi: 'BBG0013HRTL0' },
    };
    await service.commit({ systemId: 's', portfolioId: 'p', uploadId: service.stashRawRows([row]) });
    const imported = db.select().from(operations).where(eq(operations.brokerRef, 'n1')).get();
    expect(imported?.instrumentId).toBe('CNYRUB_TOM');
    expect(db.select().from(instruments).all().map((i) => i.id).sort()).toEqual(['CNYRUB_TOM', 'GLDRUB_TOM']);
  });

  it('некорректное тело — BadRequest (400), а не ZodError', () => {
    expect(() => identity.split('GLDRUB_TOM', {})).toThrow(BadRequestException);
    expect(() => identity.splitPreview('GLDRUB_TOM', null)).toThrow(BadRequestException);
  });
});
