import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sqlite } from './client';
import { applyMigrations } from './apply-migrations';

/**
 * Папка с миграциями лежит рядом с этим модулем в обоих режимах: в исходниках
 * это `apps/api/src/db/migrations`, в собранном бандле — `dist/apps/api/migrations`
 * (копируется через `assets` в webpack.config.js). Поэтому путь один и тот же
 * относительно `__dirname`, а не относительно рабочего каталога.
 */
const MIGRATIONS_FOLDER = join(__dirname, 'migrations');

/**
 * Применяет невыполненные миграции к текущей БД (логика — apply-migrations.ts).
 *
 * Вызывается при старте API: после `git pull` не нужно помнить про отдельный
 * `pnpm db:migrate`, а установка на чистом месте поднимается сама. Drizzle
 * ведёт учёт применённого в служебной таблице, так что на актуальной БД вызов
 * ничего не делает.
 */
export function runMigrations(): void {
  if (!existsSync(MIGRATIONS_FOLDER)) {
    throw new Error(
      `Папка миграций не найдена: ${MIGRATIONS_FOLDER}. ` +
        'Для собранного бандла её копирует assets в apps/api/webpack.config.js.',
    );
  }
  applyMigrations(sqlite, MIGRATIONS_FOLDER);
}
