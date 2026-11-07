import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { backfillInstrumentIdentifiers } from './instrument-identifiers-store';
import { copySnapshotsToPriceHistory } from './snapshot-to-price-history';

/** Миграция, после которой переносим данные снимков (создаёт price_history) */
const PRICE_HISTORY_TAG_SUFFIX = '_price_history';

type MigrationList = ReturnType<typeof readMigrationFiles>;
interface DrizzleInternals {
  dialect: { migrate(list: MigrationList, session: unknown, config: { migrationsFolder: string }): void };
  session: unknown;
}

/**
 * Применяет невыполненные миграции к БД.
 *
 * Работает на drizzle-обработчике без схемы: миграции — это сырой SQL, типизированный
 * клиент здесь не нужен.
 *
 * Миграции применяются в два захода, между которыми — перенос данных снимков в
 * price_history (copySnapshotsToPriceHistory). Это нужно, потому что таблицы снимков
 * удаляет более поздняя миграция: если применить всё одним вызовом, переносить будет
 * уже не из чего. Перенос идемпотентен и выполняется при каждом запуске, пока таблица
 * снимков существует (в том числе после аварийного прерывания между шагами).
 */
export function applyMigrations(sqlite: Database.Database, migrationsFolder: string): void {
  const db = drizzle(sqlite);
  const config = { migrationsFolder };
  const migrations = readMigrationFiles(config);
  // публичный migrate() применяет всё разом; частичное применение — через тот же dialect.migrate,
  // который он вызывает внутри (drizzle-orm зафиксирован; проверяется specом на реальной БД)
  const internals = db as unknown as DrizzleInternals;
  const apply = (list: MigrationList): void => internals.dialect.migrate(list, internals.session, config);

  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  };
  const split = journal.entries.find((e) => e.tag.endsWith(PRICE_HISTORY_TAG_SUFFIX));
  const tableExists = (name: string): boolean =>
    sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

  // identifiers заполняются из инструментов после ВСЕХ миграций, при каждом запуске
  // (идемпотентно): новые инструменты и поля, заведённые в обход сервиса, подхватятся
  const finish = (): void => {
    if (tableExists('instrument_identifiers')) backfillInstrumentIdentifiers(db);
  };

  if (!split) {
    apply(migrations);
    finish();
    return;
  }

  apply(migrations.filter((m) => m.folderMillis <= split.when));
  // Переносим всегда, пока таблица снимков есть, а не только «в первый запуск»: если процесс
  // убили между созданием price_history и переносом, следующий запуск иначе пропустил бы
  // перенос и миграция удаления потеряла бы историю. Перенос идемпотентен (recordPrice).
  if (tableExists('snapshot_positions')) copySnapshotsToPriceHistory(db);
  apply(migrations.filter((m) => m.folderMillis > split.when));
  finish();
}
