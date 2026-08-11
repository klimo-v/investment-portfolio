import { defineConfig } from 'drizzle-kit';
// Порядок важен: load-env кладёт DB_PATH из .env в process.env до того,
// как resolveDbPath его прочитает.
import './src/load-env';
import { resolveDbPath } from './src/db/db-path';

/**
 * Конфиг drizzle-kit (db:generate / db:studio). Путь к БД берётся той же
 * функцией, что и в рантайме, — чтобы инструменты и приложение гарантированно
 * работали с одним файлом.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './apps/api/src/db/schema.ts',
  out: './apps/api/src/db/migrations',
  dbCredentials: {
    url: resolveDbPath(),
  },
});
