import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  instruments,
  portfolios,
  portfolioSnapshots,
  quotes,
  snapshotInvalidations,
  snapshotPositions,
  systems,
} from '../../../db/schema';
import { OperationsService } from '../operations/operations.service';
import type { QuotesService } from '../quotes/quotes.service';
import { SnapshotsService } from './snapshots.service';

/**
 * Проверяем ПРАВИЛО ДОСТОВЕРНОСТИ снимков, а не разметку дашборда.
 *
 * Снимок кумулятивен: на дату захвата S он суммирует весь журнал операций, какой бы
 * датой сами операции ни были помечены. Значит правка операции с датой D портит ровно
 * те снимки, у которых date >= D, — и только тогда есть о чём предупреждать. Раньше
 * на любую такую правку история снимков стиралась целиком; цена ошибки в этом правиле
 * теперь — либо ложная тревога, либо молча неверный график.
 */

const SYSTEM_ID = 'sys-1';
const PORTFOLIO_ID = 'pf-1';
const INSTRUMENT_ID = 'inst-sber';

/** Курс валюты не участвует в проверяемом правиле — RUB-операциям хватает единицы */
const quotesStub = { getFxRate: async () => 1 } as unknown as QuotesService;

function makeDb(): BetterSQLite3Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });

  const db = drizzle(sqlite);
  db.insert(systems).values({ id: SYSTEM_ID, name: 'Тест' }).run();
  db.insert(portfolios).values({ id: PORTFOLIO_ID, name: 'Основной' }).run();
  db.insert(instruments)
    .values({ id: INSTRUMENT_ID, ticker: 'SBER', type: 'Stock', currency: 'RUB' })
    .run();
  return db;
}

/** Операция покупки на заданную дату — минимум полей, остальное по умолчанию схемы */
function buy(date: string, quantity = '10', price = '100') {
  return {
    id: randomUUID(),
    date,
    systemId: SYSTEM_ID,
    portfolioId: PORTFOLIO_ID,
    instrumentId: INSTRUMENT_ID,
    operationType: 'Buy' as const,
    quantity,
    price,
    fee: '0',
    fxRate: '1',
    currency: 'RUB',
  };
}

/** Готовый снимок на дату — минуя capture(), чтобы задать нужную ось времени */
function seedSnapshot(db: BetterSQLite3Database, date: string): void {
  db.insert(portfolioSnapshots)
    .values({
      date,
      investedRub: '1000',
      currentValueRub: '1200',
      pnlRub: '200',
      dividendsRub: '0',
    })
    .run();
}

describe('SnapshotsService — достоверность истории снимков', () => {
  let db: BetterSQLite3Database;
  let ops: OperationsService;
  let snapshots: SnapshotsService;

  beforeEach(() => {
    db = makeDb();
    ops = new OperationsService(db, quotesStub);
    snapshots = new SnapshotsService(db, ops);
  });

  it('без единого снимка правка журнала ничего не помечает — портить нечего', () => {
    const op = ops.add(buy('2026-01-10'));
    ops.delete(op.id);

    expect(db.select().from(snapshotInvalidations).all()).toHaveLength(0);
    expect(snapshots.staleness()).toEqual({ stale: false, staleSince: null, entries: [] });
  });

  it('операция ПОЗЖЕ последнего снимка не делает историю недостоверной', () => {
    seedSnapshot(db, '2026-01-15');
    const op = ops.add(buy('2026-02-01'));
    ops.delete(op.id);

    // снимок от 15 января этой операции никогда не видел — его цифры не изменились
    expect(snapshots.staleness().stale).toBe(false);
  });

  it('удаление операции ДО снимка помечает историю и указывает первый испорченный снимок', () => {
    const op = ops.add(buy('2026-01-05'));
    seedSnapshot(db, '2026-01-10');
    seedSnapshot(db, '2026-01-20');

    ops.delete(op.id);

    const staleness = snapshots.staleness();
    expect(staleness.stale).toBe(true);
    expect(staleness.staleSince).toBe('2026-01-10');
    expect(staleness.entries).toHaveLength(1);
    expect(staleness.entries[0]).toMatchObject({
      kind: 'delete',
      operationDate: '2026-01-05',
      description: 'Buy 10 SBER',
      ticker: 'SBER',
      acknowledged: false,
    });
  });

  it('добавление операции задним числом тоже помечает историю', () => {
    seedSnapshot(db, '2026-01-10');
    ops.add(buy('2026-01-01'));

    const staleness = snapshots.staleness();
    expect(staleness.stale).toBe(true);
    expect(staleness.entries[0]).toMatchObject({ kind: 'add', operationDate: '2026-01-01' });
  });

  it('переназначение системы/портфеля помечает историю', () => {
    const op = ops.add(buy('2026-01-05'));
    seedSnapshot(db, '2026-01-10');

    db.insert(portfolios).values({ id: 'pf-2', name: 'ИИС' }).run();
    ops.reassign(op.id, { portfolioId: 'pf-2' });

    expect(snapshots.staleness().entries[0]).toMatchObject({
      kind: 'reassign',
      operationDate: '2026-01-05',
    });
  });

  it('acknowledge() гасит предупреждение, но записи журнала оставляет', () => {
    const op = ops.add(buy('2026-01-05'));
    seedSnapshot(db, '2026-01-10');
    ops.delete(op.id);

    expect(snapshots.acknowledge()).toEqual({ acknowledged: 1 });

    const staleness = snapshots.staleness();
    expect(staleness.stale).toBe(false);
    expect(staleness.staleSince).toBeNull();
    expect(staleness.entries).toHaveLength(1);
    expect(staleness.entries[0].acknowledged).toBe(true);
  });

  it('новое ретро-изменение после acknowledge зажигает предупреждение снова', () => {
    const first = ops.add(buy('2026-01-05'));
    const second = ops.add(buy('2026-01-06'));
    seedSnapshot(db, '2026-01-10');

    ops.delete(first.id);
    snapshots.acknowledge();
    ops.delete(second.id);

    const staleness = snapshots.staleness();
    expect(staleness.stale).toBe(true);
    expect(staleness.entries).toHaveLength(2);
    // staleSince считается только по НЕпросмотренным записям
    expect(staleness.staleSince).toBe('2026-01-10');
  });

  it('clearHistory() стирает снимки, разбивку по инструментам и журнал изменений', () => {
    const op = ops.add(buy('2026-01-05'));
    seedSnapshot(db, '2026-01-10');
    db.insert(snapshotPositions)
      .values({ date: '2026-01-10', instrumentId: INSTRUMENT_ID, valueRub: '1200', quantity: '10' })
      .run();
    ops.delete(op.id);

    expect(snapshots.clearHistory()).toEqual({ deleted: true });

    expect(db.select().from(portfolioSnapshots).all()).toHaveLength(0);
    expect(db.select().from(snapshotPositions).all()).toHaveLength(0);
    expect(db.select().from(snapshotInvalidations).all()).toHaveLength(0);
    expect(snapshots.staleness().stale).toBe(false);
  });

  it('повторный capture() за день обновляет точку дня, а не добавляет вторую', async () => {
    ops.add(buy('2026-01-05', '10', '100'));
    db.insert(quotes)
      .values({
        instrumentId: INSTRUMENT_ID,
        price: '150',
        currency: 'RUB',
        source: 'manual',
        asOf: '2026-01-05T00:00:00Z',
      })
      .run();

    await snapshots.capture();
    db.update(quotes).set({ price: '200' }).run();
    const second = await snapshots.capture();

    const rows = db.select().from(portfolioSnapshots).all();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].currentValueRub)).toBe(second.currentValueRub);
    expect(second.currentValueRub).toBe(2000); // 10 × 200

    const positionRows = db.select().from(snapshotPositions).all();
    expect(positionRows).toHaveLength(1);
    expect(Number(positionRows[0].valueRub)).toBe(2000);
  });
});
