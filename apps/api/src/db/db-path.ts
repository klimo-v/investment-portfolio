import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Путь к файлу SQLite + гарантия существования папки (better-sqlite3 её сам не
 * создаёт и падает с "Cannot open database because the directory does not exist").
 */
export function resolveDbPath(): string {
  const dbPath = process.env['DB_PATH'] ?? 'data/portfolio.sqlite';
  mkdirSync(dirname(dbPath), { recursive: true });
  return dbPath;
}
