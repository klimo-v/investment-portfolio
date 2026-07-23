import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { resolveDbPath } from './db-path';

/**
 * Файл БД — в переменной окружения DB_PATH, по умолчанию data/portfolio.sqlite
 * (папка data/ уже в .gitignore — локальные данные не коммитятся).
 */
const sqlite = new Database(resolveDbPath());
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
export type Db = typeof db;
