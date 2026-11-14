import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fromAppRoot } from '../app-paths';

/**
 * Путь к файлу SQLite + гарантия существования папки (better-sqlite3 её сам не
 * создаёт и падает с "Cannot open database because the directory does not exist").
 *
 * При DATA_DIR относительный DB_PATH считается от каталога данных (по умолчанию
 * portfolio.sqlite), иначе — от корня приложения (data/portfolio.sqlite).
 * Пути не зависят от рабочего каталога:
 * иначе запуск из другого каталога тихо заводит вторую пустую БД вместо того,
 * чтобы открыть существующую. Абсолютный DB_PATH используется как есть.
 */
export function resolveDbPath(): string {
  const dbPath = process.env['DATA_DIR']
    ? resolve(process.env['DATA_DIR'], process.env['DB_PATH'] ?? 'portfolio.sqlite')
    : fromAppRoot(process.env['DB_PATH'] ?? 'data/portfolio.sqlite');
  mkdirSync(dirname(dbPath), { recursive: true });
  return dbPath;
}
