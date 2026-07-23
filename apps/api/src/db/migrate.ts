import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolveDbPath } from './db-path';

/**
 * Запуск миграций: pnpm db:generate (сгенерировать SQL из schema.ts),
 * затем pnpm db:migrate (применить к файлу БД).
 */
const dbPath = resolveDbPath();
const sqlite = new Database(dbPath);
const db = drizzle(sqlite);

migrate(db, { migrationsFolder: './apps/api/src/db/migrations' });

// eslint-disable-next-line no-console
console.log(`Миграции применены к ${dbPath}`);
sqlite.close();
