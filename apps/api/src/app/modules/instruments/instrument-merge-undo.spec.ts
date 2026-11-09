import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { and, eq } from 'drizzle-orm';
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
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

/** Откат слияния: разделение по журналу + точное восстановление из снимка */
let db: BetterSQLite3Database;
let identity: InstrumentIdentityService;

const addOp = (id: string, instrumentId: string, sourceCode: string | null = null) =>
  db.insert(operations).values({ id, date: '2025-01-10', systemId: 's', portfolioId: 'p', instrumentId, operationType: 'Buy', quantity: '1', price: '100', fee: '0', fxRate: '1', currency: 'RUB', sourceCode }).run();
const addInstrument = (id: string, ticker: string, extra: Partial<typeof instruments.$inferInsert> = {}) =>
  db.insert(instruments).values({ id, ticker, type: 'Bond', currency: 'RUB', marketSource: 'moex', ...extra }).run();
const addCode = (instrumentId: string, scheme: string, value: string, origin = 'import', createdAt = '2026-01-01 10:00:00') =>
  db.insert(instrumentIdentifiers).values({ scheme: scheme as never, value, instrumentId, origin: origin as never, createdAt }).run();

/** Снимок интересующих таблиц — для сравнения «до слияния» и «после отката» */
const state = () => ({
  instruments: db.select().from(instruments).all().sort((a, b) => a.id.localeCompare(b.id)),
  operations: db.select().from(operations).all().map((o) => [o.id, o.instrumentId]).sort(),
  prices: db.select().from(priceHistory).all().sort((a, b) => (a.instrumentId + a.date).localeCompare(b.instrumentId + b.date)),
  quotes: db.select().from(quotes).all(),
  codes: db.select().from(instrumentIdentifiers).all().sort((a, b) => (a.scheme + a.value).localeCompare(b.scheme + b.value)),
  settlements: db.select().from(futuresSettlements).all().sort((a, b) => (a.instrumentId + a.date).localeCompare(b.instrumentId + b.date)),
});

beforeEach(() => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
  db = drizzle(sqlite);
  db.insert(systems).values({ id: 's', name: 'S' }).run();
  db.insert(portfolios).values({ id: 'p', name: 'P' }).run();
  addInstrument('OLD', 'TCS00X', { isin: 'RU000A106DL2', name: 'Старый выпуск', marketSource: 'manual' });
  addInstrument('NEW', 'RU000A10B4K3');
  addCode('OLD', 'ticker', 'TCS00X', 'import', '2025-12-01 09:00:00');
  addCode('OLD', 'figi', 'FIGI-OLD', 'import', '2025-12-02 09:00:00');
  addCode('OLD', 'name', 'старый выпуск', 'manual', '2025-12-03 09:00:00');
  addCode('NEW', 'ticker', 'RU000A10B4K3');
  addCode('NEW', 'figi', 'FIGI-NEW');
  addOp('o1', 'OLD', 'figi:FIGI-OLD');
  addOp('o2', 'OLD');
  addOp('n1', 'NEW', 'figi:FIGI-NEW');
  db.insert(priceHistory).values([
    { instrumentId: 'OLD', date: '2025-01-01', price: '90', currency: 'RUB', source: 'moex' },
    { instrumentId: 'OLD', date: '2025-01-02', price: '91', currency: 'RUB', source: 'moex' },
    { instrumentId: 'NEW', date: '2025-01-02', price: '50', currency: 'RUB', source: 'manual' },
  ]).run();
  db.insert(quotes).values({ instrumentId: 'OLD', price: '95', currency: 'RUB', source: 'manual', asOf: '2025-01-03T00:00:00Z' }).run();
  db.insert(futuresSettlements).values([
    { portfolioId: 'p', instrumentId: 'OLD', date: '2025-01-05', vmPeriod: '1', vmPlanned: '1' },
    { portfolioId: 'p', instrumentId: 'OLD', date: '2025-01-06', vmPeriod: '2', vmPlanned: '2' },
    { portfolioId: 'p', instrumentId: 'NEW', date: '2025-01-06', vmPeriod: '9', vmPlanned: '9' },
  ]).run();
  identity = new InstrumentIdentityService(db as never);
});

const merge = (s = 'OLD', t = 'NEW') => {
  identity.merge(s, t, { confirmWarnings: true });
  return db.select().from(instrumentHistory).all().filter((h) => h.kind === 'merge').at(-1)!.id;
};

describe('откат слияния', () => {
  it('чистый откат возвращает ровно прежнее состояние (поля, origin и created_at кодов, цены, котировка, маржа)', () => {
    const before = state();
    const id = merge();
    // операции, перенесённые слиянием, известны по id из снимка (даже без кода) — неясных нет
    expect(identity.undoPlan(id).plan.unclear).toEqual([]);
    const res = identity.undoMerge(id);
    expect(res).toMatchObject({ sourceId: 'OLD', movedOperations: 2 });
    expect(state()).toEqual(before);
    const ev = db.select().from(instrumentHistory).where(eq(instrumentHistory.id, id)).get()!;
    expect(ev.undoneAt).not.toBeNull();
    expect(ev.undoneBy).toBeTruthy();
    // повторный откат — отказ
    expect(() => identity.undoMerge(id)).toThrow(/уже отменено/);
  });

  it('новые операции после слияния: с кодом источника → источнику, с кодом цели → цели, без кода — решает пользователь', () => {
    const id = merge();
    addOp('p1', 'NEW', 'figi:FIGI-OLD'); // пришла под кодом источника
    addOp('p2', 'NEW', 'figi:FIGI-NEW'); // под кодом цели
    addOp('p3', 'NEW', null); // ручная
    addOp('p4', 'NEW', 'figi:BRAND-NEW'); // новый код
    const plan = identity.undoPlan(id).plan;
    expect(plan.toSource.sort()).toEqual(['o1', 'o2', 'p1']); // o1/o2 — по id из снимка, p1 — по коду
    expect(() => identity.undoMerge(id)).toThrow(/неясные/);
    expect(plan.toTarget.sort()).toEqual(['n1', 'p2']);
    expect(plan.unclear.map((o) => o.id).sort()).toEqual(['p3', 'p4']);
    identity.undoMerge(id, { assignments: { toTarget: ['p3', 'p4'] } });
    const owners = Object.fromEntries(db.select().from(operations).all().map((o) => [o.id, o.instrumentId]));
    expect(owners).toEqual({ o1: 'OLD', o2: 'OLD', p1: 'OLD', n1: 'NEW', p2: 'NEW', p3: 'NEW', p4: 'NEW' });
  });

  it('чужие данные цели сохраняются: изменённая после слияния цена не откатывается, код, добавленный после слияния, остаётся у цели', () => {
    const id = merge();
    db.update(priceHistory).set({ price: '77' }).where(and(eq(priceHistory.instrumentId, 'NEW'), eq(priceHistory.date, '2025-01-02'))).run(); // правка после слияния
    db.insert(priceHistory).values({ instrumentId: 'NEW', date: '2025-02-01', price: '60', currency: 'RUB', source: 'moex' }).run();
    addCode('NEW', 'tbank_uid', 'uid-after', 'import', '2999-01-01 00:00:00');
    const plan = identity.undoPlan(id).plan;
    expect(plan.identifiersAfterMerge.map((c) => c.value)).toEqual(['uid-after']);
    identity.undoMerge(id, { assignments: { toSource: ['o2'] } });
    const targetPrices = db.select().from(priceHistory).where(eq(priceHistory.instrumentId, 'NEW')).all().map((p) => `${p.date}:${p.price}`).sort();
    // 01-02: слияние заменило ручную 50 рыночной 91, потом цена правилась на 77 — не откатывается; 01-01 (добавлена слиянием, но изменена не была) убрана
    expect(targetPrices).toEqual(['2025-01-02:77', '2025-02-01:60']);
    expect(db.select().from(instrumentIdentifiers).all().find((c) => c.value === 'uid-after')?.instrumentId).toBe('NEW');
    // собственные цены источника — точно из снимка
    expect(db.select().from(priceHistory).where(eq(priceHistory.instrumentId, 'OLD')).all()).toHaveLength(2);
  });

  it('удалённые после слияния операции пропускаются и называются в плане', () => {
    const id = merge();
    db.delete(operations).where(eq(operations.id, 'o1')).run();
    const plan = identity.undoPlan(id, { assignments: { toSource: ['o2'] } }).plan;
    expect(plan.skippedOperations).toEqual(['o1']);
    expect(identity.undoMerge(id, { assignments: { toSource: ['o2'] } }).movedOperations).toBe(1);
  });

  it('цепочка A → B → C: сначала нужно отменить более позднее слияние', () => {
    addInstrument('C', 'RU000A10B4K9');
    const first = merge('OLD', 'NEW');
    const second = merge('NEW', 'C');
    expect(() => identity.undoMerge(first, { assignments: { toSource: ['o2'] } })).toThrow(/Сначала отмените/);
    identity.undoMerge(second);
    expect(db.select().from(instruments).all().map((i) => i.id).sort()).toEqual(['C', 'NEW']);
    identity.undoMerge(first, { assignments: { toSource: ['o2'] } });
    expect(db.select().from(instruments).all().map((i) => i.id).sort()).toEqual(['C', 'NEW', 'OLD']);
  });

  it('занятый id источника — отказ', () => {
    const id = merge();
    addInstrument('OLD', 'TCS00X-AGAIN');
    expect(() => identity.undoMerge(id, { assignments: { toSource: ['o2'] } })).toThrow(/занят/);
  });

  it('откат — одна транзакция: сбой журнала оставляет всё как после слияния', () => {
    const id = merge();
    const afterMerge = state();
    const sqlite = (db as unknown as { session: { client: Database.Database } }).session.client;
    sqlite.exec(`CREATE TRIGGER stop_split BEFORE INSERT ON instrument_history WHEN NEW.kind = 'split' BEGIN SELECT RAISE(ABORT, 'нельзя'); END;`);
    expect(() => identity.undoMerge(id, { assignments: { toSource: ['o2'] } })).toThrow();
    expect(state()).toEqual(afterMerge);
  });

  it('некорректное тело отката и плана — BadRequest (400)', () => {
    const id = merge();
    expect(() => identity.undoMerge(id, { assignments: { toSource: 5 } })).toThrow(BadRequestException);
    expect(() => identity.undoPlan(id, { assignments: 'x' })).toThrow(BadRequestException);
  });

  it('цепочка A → B → C: у C видно слияние A → B с его целью; после отката всех слияний инструмент уходит из списка', () => {
    addInstrument('C', 'RU000A10B4K9');
    const first = merge('OLD', 'NEW');
    const second = merge('NEW', 'C');
    const merges = identity.identifiers('C').merges;
    expect(merges.map((m) => [m.sourceTicker, m.targetId])).toEqual([['TCS00X', 'NEW'], ['RU000A10B4K3', 'C']]);
    // сообщение об очерёдности называет тикер цели, а не id
    expect(() => identity.undoMerge(first)).toThrow(/RU000A10B4K9/);
    identity.undoMerge(second);
    identity.undoMerge(first, { assignments: { toSource: ['o2'] } });
    expect(identity.mergedIdentifiers().map((i) => i.instrumentId)).not.toContain('NEW');
  });
});
