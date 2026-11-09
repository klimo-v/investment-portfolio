import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseMergePayload } from '@core';
import { backfillInstrumentIdentifiers } from '../../../db/instrument-identifiers-store';
import {
  futuresSettlements,
  instrumentHistory,
  instrumentIdentifiers,
  instruments,
  operations,
  portfolios,
  priceHistory,
  quotes,
  systems,
} from '../../../db/schema';
import { InstrumentIdentityService } from './instrument-identity.service';

/** Журнал слияний: снимок пишется в той же транзакции и содержит всё, что слияние меняет или теряет */
let sqlite: Database.Database;
let db: BetterSQLite3Database;
let service: InstrumentIdentityService;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
  db = drizzle(sqlite);
  db.insert(systems).values({ id: 's', name: 'S' }).run();
  db.insert(portfolios).values({ id: 'p', name: 'P' }).run();
  db.insert(instruments)
    .values([
      { id: 'OLD', ticker: 'TCS00X', type: 'Bond', currency: 'RUB', isin: 'RU000A106DL2', name: 'Старый выпуск', marketSource: 'manual' },
      { id: 'NEW', ticker: 'RU000A10B4K3', type: 'Bond', currency: 'RUB', isin: null, name: null, marketSource: 'moex' },
    ])
    .run();
  const op = (id: string, instrumentId: string) =>
    db.insert(operations).values({ id, date: '2025-01-10', systemId: 's', portfolioId: 'p', instrumentId, operationType: 'Buy', quantity: '1', price: '100', fee: '0', fxRate: '1', currency: 'RUB' }).run();
  op('op1', 'OLD');
  op('op2', 'OLD');
  op('op3', 'NEW');
  db.insert(priceHistory)
    .values([
      { instrumentId: 'OLD', date: '2025-01-01', price: '90', currency: 'RUB', source: 'moex' },
      { instrumentId: 'OLD', date: '2025-01-02', price: '91', currency: 'RUB', source: 'moex' },
      { instrumentId: 'NEW', date: '2025-01-02', price: '50', currency: 'RUB', source: 'manual' },
    ])
    .run();
  db.insert(quotes).values({ instrumentId: 'OLD', price: '95', currency: 'RUB', source: 'manual', asOf: '2025-01-03T00:00:00Z' }).run();
  backfillInstrumentIdentifiers(db as never);
  service = new InstrumentIdentityService(db as never);
});

describe('журнал слияний', () => {
  it('снимок содержит операции, цены, перезаписанные строки цели, котировку, коды и поля цели', () => {
    const codesBefore = db.select().from(instrumentIdentifiers).all().filter((e) => e.instrumentId === 'OLD');
    service.merge('OLD', 'NEW', { confirmWarnings: true });

    const [entry] = db.select().from(instrumentHistory).all();
    expect(entry).toMatchObject({ kind: 'merge', sourceId: 'OLD', targetId: 'NEW', undoneAt: null, undoneBy: null });
    const p = parseMergePayload(entry.payload);
    expect(p.version).toBe(1);
    expect(p.source).toMatchObject({ id: 'OLD', ticker: 'TCS00X', isin: 'RU000A106DL2', name: 'Старый выпуск', marketSource: 'manual' });
    expect(p.movedOperationIds.sort()).toEqual(['op1', 'op2']);
    expect(p.sourcePrices).toHaveLength(2);
    expect(p.sourceQuote).toMatchObject({ price: '95' });
    expect(p.targetFilled).toEqual({ isin: 'RU000A106DL2', name: 'Старый выпуск' });
    // 01-01 добавлена в цель; 01-02: рыночная цена источника заменила ручную цель
    expect(p.targetPricesInserted.map((r) => r['date'])).toEqual(['2025-01-01']);
    expect(p.targetPricesOverwritten).toHaveLength(1);
    expect(p.targetPricesOverwritten[0].before).toMatchObject({ price: '50', source: 'manual' });
    expect(p.targetPricesOverwritten[0].after).toMatchObject({ price: '91', source: 'moex' });
    // коды источника — с исходными origin/created_at
    expect(p.sourceIdentifiers.map((e) => `${e.scheme}:${e.value}:${e.origin}:${e.createdAt}`).sort()).toEqual(
      codesBefore.map((e) => `${e.scheme}:${e.value}:${e.origin}:${e.createdAt}`).sort(),
    );
    // источник удалён, операции у цели
    expect(db.select().from(instruments).all().map((i) => i.id)).toEqual(['NEW']);
  });

  it('вариационная маржа: перенесённые и потерянные строки', () => {
    db.insert(futuresSettlements)
      .values([
        { portfolioId: 'p', instrumentId: 'OLD', date: '2025-01-05', vmPeriod: '1', vmPlanned: '1' },
        { portfolioId: 'p', instrumentId: 'OLD', date: '2025-01-06', vmPeriod: '2', vmPlanned: '2' },
        { portfolioId: 'p', instrumentId: 'NEW', date: '2025-01-06', vmPeriod: '9', vmPlanned: '9' },
      ])
      .run();
    service.merge('OLD', 'NEW', { confirmWarnings: true });
    const p = parseMergePayload(db.select().from(instrumentHistory).get()!.payload);
    expect(p.settlementsMoved.map((r) => r['date'])).toEqual(['2025-01-05']);
    expect(p.settlementsLost.map((r) => r['date'])).toEqual(['2025-01-06']);
  });

  it('откат транзакции не оставляет записи журнала и ничего не меняет', () => {
    sqlite.exec(`CREATE TRIGGER stop_delete BEFORE DELETE ON instruments BEGIN SELECT RAISE(ABORT, 'нельзя'); END;`);
    expect(() => service.merge('OLD', 'NEW', { confirmWarnings: true })).toThrow();
    expect(db.select().from(instrumentHistory).all()).toHaveLength(0);
    expect(db.select().from(operations).all().filter((o) => o.instrumentId === 'OLD')).toHaveLength(2);
    expect(db.select().from(priceHistory).all()).toHaveLength(3);
  });

  it('виджет: «слито из X» берётся из журнала, цепочка A → B → C видна у C', () => {
    db.insert(instruments).values({ id: 'C', ticker: 'RU000A10B4K3X', type: 'Bond', currency: 'RUB', marketSource: 'moex' }).run();
    service.merge('OLD', 'NEW', { confirmWarnings: true });
    service.merge('NEW', 'C', { confirmWarnings: true });
    const dto = service.identifiers('C');
    expect(dto.merges.map((m) => m.sourceTicker)).toEqual(['TCS00X', 'RU000A10B4K3']);
    expect(service.mergedIdentifiers().map((i) => i.instrumentId)).toContain('C');
  });
});
