import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './apply-migrations';
import { backfillInstrumentIdentifiers } from './instrument-identifiers-store';
import { planDuplicateMerge, runDuplicateMerge } from './instrument-duplicates';
import { instruments, operations, portfolios, systems } from './schema';
import { join } from 'node:path';

let sqlite: Database.Database;
let db: BetterSQLite3Database;

const op = (id: string, instrumentId: string, type: 'Buy' | 'Sell', qty: string, price: string, date = '2026-01-10') => ({
  id,
  date,
  systemId: 'sys',
  portfolioId: 'pf',
  instrumentId,
  operationType: type,
  quantity: qty,
  price,
  fee: '1',
  currency: 'RUB',
});

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite, join(__dirname, 'migrations'));
  db = drizzle(sqlite);
  db.insert(systems).values({ id: 'sys', name: 'S' }).run();
  db.insert(portfolios).values({ id: 'pf', name: 'P' }).run();
  db.insert(instruments)
    .values([
      { id: 'TMON', ticker: 'TMON', type: 'ETF', currency: 'RUB', marketSource: 'moex' },
      { id: 'TMON@', ticker: 'TMON@', type: 'ETF', currency: 'RUB', name: 'Денежный рынок', marketSource: 'manual' },
      { id: 'LONE@', ticker: 'LONE@', type: 'ETF', currency: 'RUB', marketSource: 'manual' },
      { id: 'RU000A10B4K3', ticker: 'RU000A10B4K3', type: 'Bond', currency: 'RUB', marketSource: 'moex' },
      { id: 'TCS00A10B4K3', ticker: 'TCS00A10B4K3', type: 'Bond', currency: 'RUB', marketSource: 'manual' },
    ])
    .run();
  backfillInstrumentIdentifiers(db);
  db.insert(operations)
    .values([
      op('1', 'TMON@', 'Buy', '10', '100'),
      op('2', 'TMON@', 'Sell', '4', '110', '2026-02-01'),
      op('3', 'LONE@', 'Buy', '5', '50'),
      op('4', 'TCS00A10B4K3', 'Buy', '2', '900'),
    ])
    .run();
});

describe('миграция существующих дублей', () => {
  it('план: TMON@→TMON детерминированно; одиночный LONE@ — только тикер; TCS…/RU… — вручную', () => {
    const plan = planDuplicateMerge(db);
    expect(plan.merges).toEqual([
      expect.objectContaining({ sourceId: 'TMON@', targetId: 'TMON', operations: 2 }),
    ]);
    expect(plan.renames).toEqual([expect.objectContaining({ instrumentId: 'LONE@', from: 'LONE@', to: 'LONE' })]);
    expect(plan.manual).toEqual([expect.objectContaining({ a: 'RU000A10B4K3', b: 'TCS00A10B4K3' })]);
  });

  it('dry-run (только plan) ничего не меняет', () => {
    planDuplicateMerge(db);
    expect(db.select().from(instruments).all()).toHaveLength(5);
  });

  it('применение: слияние + правка тикера, инварианты совпали; id одиночного не менялся; недетерминированный не тронут', () => {
    const res = runDuplicateMerge(sqlite, planDuplicateMerge(db));
    expect(res.applied).toBe(true);
    expect(res.problems).toEqual([]);
    expect(res.after).toEqual(res.before);

    const ids = db.select().from(instruments).all().map((i) => i.id).sort();
    expect(ids).toEqual(['LONE@', 'RU000A10B4K3', 'TCS00A10B4K3', 'TMON']);
    expect(db.select().from(instruments).all().find((i) => i.id === 'LONE@')?.ticker).toBe('LONE');
    const moved = db.select().from(operations).all().filter((o) => o.instrumentId === 'TMON');
    expect(moved).toHaveLength(2);
  });

  it('повторный запуск — плана нет (идемпотентно)', () => {
    runDuplicateMerge(sqlite, planDuplicateMerge(db));
    const plan = planDuplicateMerge(db);
    expect(plan.merges).toEqual([]);
    expect(plan.renames).toEqual([]);
  });

  it('расхождение инвариантов → откат: ничего не изменилось', () => {
    // слияние двух инструментов с открытыми позициями меняет число позиций — защита обязана откатить
    db.insert(operations).values(op('5', 'TMON', 'Buy', '3', '100')).run();
    const res = runDuplicateMerge(sqlite, {
      merges: [{ sourceId: 'TMON@', targetId: 'TMON', operations: 2, reason: 'тест' }],
      renames: [],
      manual: [],
    });
    expect(res.applied).toBe(false);
    expect(res.problems.join(' ')).toMatch(/openPositions|investedRub|realizedPnlRub/);
    expect(db.select().from(instruments).all()).toHaveLength(5);
    expect(db.select().from(operations).all().filter((o) => o.instrumentId === 'TMON@')).toHaveLength(2);
  });
});
