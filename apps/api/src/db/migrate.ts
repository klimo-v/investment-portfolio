import '../load-env';
import { sqlite } from './client';
import { resolveDbPath } from './db-path';
import { runMigrations } from './run-migrations';

/**
 * Ручной прогон миграций: `pnpm db:migrate`.
 *
 * API применяет миграции сам при старте (см. run-migrations.ts), поэтому скрипт
 * нужен для случаев без запуска сервера — например сразу после `pnpm db:generate`
 * или чтобы обновить копию БД.
 */
runMigrations();

console.log(`Миграции применены к ${resolveDbPath()}`);
sqlite.close();
