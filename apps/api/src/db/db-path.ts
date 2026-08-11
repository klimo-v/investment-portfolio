import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fromAppRoot } from '../app-paths';

/**
 * Путь к файлу SQLite + гарантия существования папки (better-sqlite3 её сам не
 * создаёт и падает с "Cannot open database because the directory does not exist").
 *
 * Относительный DB_PATH считается от корня приложения, а не от рабочего каталога:
 * иначе запуск из другого каталога тихо заводит вторую пустую БД вместо того,
 * чтобы открыть существующую. Абсолютный DB_PATH используется как есть.
 */
export function resolveDbPath(): string {
  const dbPath = fromAppRoot(process.env['DB_PATH'] ?? 'data/portfolio.sqlite');
  mkdirSync(dirname(dbPath), { recursive: true });
  return dbPath;
}
