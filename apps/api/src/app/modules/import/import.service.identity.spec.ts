import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RawRow } from '@core';
import { backfillInstrumentIdentifiers } from '../../../db/instrument-identifiers-store';
import {
  futuresSettlements,
  instrumentIdentifiers,
  instruments,
  operations,
  portfolios,
  priceHistory,
  systems,
} from '../../../db/schema';
import { InstrumentIdentityService } from '../instruments/instrument-identity.service';
import { ImportService, type ImportFormat } from './import.service';

/**
 * Идентичность инструментов при импорте: один актив из разных источников не заводит
 * дубль, решение пользователя и слияние запоминаются (docs/02-data-model.md).
 * Данные синтетические.
 */
let db: BetterSQLite3Database;
let identity: InstrumentIdentityService;
let service: ImportService;
const opts = { systemId: 'sys-1', portfolioId: 'pf-1' };

const buy = (p: Partial<RawRow>): RawRow => ({
  date: '2026-11-05',
  tradeType: 'Buy',
  currency: 'RUB',
  quantity: '10',
  price: '100',
  fee: '0',
  ...p,
});

const instrumentIds = (): string[] =>
  db.select().from(instruments).all().map((i) => i.id).sort();

beforeEach(() => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
  db = drizzle(sqlite);
  db.insert(systems).values({ id: 'sys-1', name: 'Тест' }).run();
  db.insert(portfolios).values({ id: 'pf-1', name: 'ИИС' }).run();
  db.insert(instruments)
    .values([
      { id: 'TMON', ticker: 'TMON', type: 'ETF', currency: 'RUB', name: 'паи БПИФ рфи Т-КапиталДенРынок', marketSource: 'moex' },
      { id: 'RU000A10B4K3', ticker: 'RU000A10B4K3', type: 'Bond', currency: 'RUB', isin: 'RU000A10B4K3', name: 'НорНикБ1P8', marketSource: 'moex' },
    ])
    .run();
  backfillInstrumentIdentifiers(db);
  identity = new InstrumentIdentityService(db);
  service = new ImportService(db, identity);
});

describe('импорт: один актив из разных источников — один инструмент', () => {
  it('TMON@ из API и TMON из xlsx → один инструмент TMON, дубля TMON@ нет', async () => {
    const uploadId = service.stashRawRows([
      buy({ ticker: 'TMON@', name: 'Денежный рынок', instrumentType: 'ETF', brokerRef: 'a1', identifiers: { figi: 'BBG-TMON' } }),
      buy({ ticker: 'TMON', name: 'паи БПИФ рфи Т-КапиталДенРынок', instrumentType: 'ETF', brokerRef: 'a2' }),
    ]);
    await service.commit({ ...opts, uploadId });

    expect(instrumentIds()).toEqual(['RU000A10B4K3', 'TMON']);
    expect(db.select().from(operations).all().map((o) => o.instrumentId)).toEqual(['TMON', 'TMON']);
    // выучены figi и новое название — повторный импорт по figi найдёт сам
    const learned = db.select().from(instrumentIdentifiers).where(eq(instrumentIdentifiers.instrumentId, 'TMON')).all();
    expect(learned.map((l) => `${l.scheme}:${l.value}`)).toEqual(
      expect.arrayContaining(['figi:BBG-TMON', 'name:денежный рынок']),
    );
  });

  it('выплата только с ISIN (без тикера) попадает в инструмент по ISIN', async () => {
    const uploadId = service.stashRawRows([
      buy({ tradeType: 'Dividend', quantity: '1', price: '50', identifiers: { isin: 'RU000A10B4K3' }, brokerRef: 'd1' }),
    ]);
    await service.commit({ ...opts, uploadId });
    expect(db.select().from(operations).all()[0].instrumentId).toBe('RU000A10B4K3');
    expect(instrumentIds()).toEqual(['RU000A10B4K3', 'TMON']);
  });

  it('конфликт идентификаторов (тикер → TMON, ISIN → облигация) — строка с ошибкой, ничего не заведено', async () => {
    const uploadId = service.stashRawRows([buy({ ticker: 'TMON', identifiers: { isin: 'RU000A10B4K3' }, brokerRef: 'c1' })]);
    const p = await service.preview({ ...opts, uploadId });
    expect(p.rows[0].confidence).toBe('error');
    expect(p.rows[0].reason).toMatch(/разные инструменты/);
    const res = await service.commit({ ...opts, uploadId });
    expect(res.imported).toBe(0);
    expect(instrumentIds()).toEqual(['RU000A10B4K3', 'TMON']);
  });
});

describe('неопознанный инструмент: подсказка и выбор пользователя', () => {
  const tcs = (): RawRow =>
    buy({ ticker: 'TCS00A10B4K3', instrumentType: 'Bond', name: 'ГМК Норникель БО-001Р-08', identifiers: { figi: 'BBG-NORNIK' }, brokerRef: 'b1' });

  it('preview: новый инструмент с подсказкой «возможно, это RU000A10B4K3», строка warn, БД не тронута', async () => {
    const uploadId = service.stashRawRows([tcs()]);
    const p = await service.preview({ ...opts, uploadId });
    expect(p.unresolvedInstruments).toHaveLength(1);
    expect(p.unresolvedInstruments[0]).toMatchObject({ key: 'TCS00A10B4K3', instrumentType: 'Bond' });
    expect(p.unresolvedInstruments[0].suggestions[0]).toMatchObject({ instrumentId: 'RU000A10B4K3' });
    expect(p.rows[0].confidence).toBe('warn');
    expect(instrumentIds()).toEqual(['RU000A10B4K3', 'TMON']);
  });

  it('выбор «существующий»: дубль не создаётся; повторный импорт после удаления сделок резолвится сам', async () => {
    const uploadId = service.stashRawRows([tcs()]);
    await service.commit({ ...opts, uploadId, instrumentChoices: { TCS00A10B4K3: { action: 'existing', instrumentId: 'RU000A10B4K3' } } });
    expect(instrumentIds()).toEqual(['RU000A10B4K3', 'TMON']);
    expect(db.select().from(operations).all()[0].instrumentId).toBe('RU000A10B4K3');

    db.delete(operations).run();
    const again = service.stashRawRows([tcs()]);
    const p = await service.preview({ ...opts, uploadId: again });
    expect(p.unresolvedInstruments).toEqual([]);
    await service.commit({ ...opts, uploadId: again });
    expect(instrumentIds()).toEqual(['RU000A10B4K3', 'TMON']);
    expect(db.select().from(operations).all()[0].instrumentId).toBe('RU000A10B4K3');
  });

  it('сценарий пользователя: импорт → «Слить» → удалить сделки → повторный импорт — дубля нет', async () => {
    await service.commit({ ...opts, uploadId: service.stashRawRows([tcs()]), instrumentChoices: { TCS00A10B4K3: { action: 'new' } } });
    expect(instrumentIds()).toEqual(['RU000A10B4K3', 'TCS00A10B4K3', 'TMON']);

    const res = identity.merge('TCS00A10B4K3', 'RU000A10B4K3');
    expect(res).toEqual({ merged: true, movedOperations: 1 });
    expect(instrumentIds()).toEqual(['RU000A10B4K3', 'TMON']);

    db.delete(operations).run();
    db.delete(systems).where(eq(systems.id, 'nope')).run();
    await service.commit({ ...opts, uploadId: service.stashRawRows([tcs()]) });
    expect(instrumentIds()).toEqual(['RU000A10B4K3', 'TMON']);
    expect(db.select().from(operations).all().map((o) => o.instrumentId)).toEqual(['RU000A10B4K3']);
  });
});

describe('слияние инструментов', () => {
  it('переносит операции, цены (одна валюта), вариационную маржу и идентификаторы; всё в одной транзакции', () => {
    db.insert(instruments).values({ id: 'OLD', ticker: 'OLD', type: 'Bond', currency: 'RUB', name: 'Старый', marketSource: 'manual' }).run();
    backfillInstrumentIdentifiers(db);
    db.insert(operations)
      .values({ id: 'o1', date: '2026-01-01', systemId: 'sys-1', portfolioId: 'pf-1', instrumentId: 'OLD', operationType: 'Buy', quantity: '1', price: '1', currency: 'RUB' })
      .run();
    db.insert(priceHistory).values({ instrumentId: 'OLD', date: '2026-01-01', price: '5', currency: 'RUB', accruedInterest: null, accruedCurrency: null, source: 'broker-report' }).run();
    db.insert(futuresSettlements)
      .values({ portfolioId: 'pf-1', instrumentId: 'OLD', date: '2026-01-01', periodFrom: null, vmPeriod: '0', vmPlanned: '0', qtyStart: '0', markStart: '0', markEnd: '0', source: 'broker-report' })
      .run();

    identity.merge('OLD', 'RU000A10B4K3');

    expect(instrumentIds()).toEqual(['RU000A10B4K3', 'TMON']);
    expect(db.select().from(operations).all()[0].instrumentId).toBe('RU000A10B4K3');
    expect(db.select().from(priceHistory).where(eq(priceHistory.instrumentId, 'RU000A10B4K3')).all()).toHaveLength(1);
    expect(db.select().from(futuresSettlements).all()[0].instrumentId).toBe('RU000A10B4K3');
    const moved = db.select().from(instrumentIdentifiers).where(eq(instrumentIdentifiers.value, 'OLD')).all();
    expect(moved).toMatchObject([{ instrumentId: 'RU000A10B4K3', origin: 'merge' }]);
  });

  it('разные типы — отказ без изменений', () => {
    expect(() => identity.merge('TMON', 'RU000A10B4K3')).toThrow(/разных типов/);
    expect(instrumentIds()).toEqual(['RU000A10B4K3', 'TMON']);
  });

  it('возможные дубли: TMON@/TMON — детерминированный', () => {
    db.insert(instruments).values({ id: 'TMON@', ticker: 'TMON@', type: 'ETF', currency: 'RUB', name: 'Денежный рынок', marketSource: 'manual' }).run();
    const dups = identity.possibleDuplicates();
    expect(dups).toHaveLength(1);
    expect(dups[0]).toMatchObject({ sourceId: 'TMON@', targetId: 'TMON', deterministic: true });
  });
});

describe('форматы файлового импорта', () => {
  it.each(['xlsx', 'pdf', 'xml'])('отклоняет неподдерживаемый формат %s без записи операций', async (format) => {
    await expect(service.preview({ content: 'unsupported', format: format as ImportFormat }))
      .rejects.toThrow('Неподдерживаемый формат отчёта');
    expect(db.select().from(operations).all()).toHaveLength(0);
  });
});
