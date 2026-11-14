/**
 * Загрузка `.env` в `process.env`. Нативная возможность Node 20.12+ — вместо
 * зависимости dotenv (CLAUDE.md §11: не вводим новые пакеты без нужды).
 *
 * Импортируется из profile/entry.ts до подготовки профиля и динамического импорта
 * http-server.ts: db/client.ts открывает SQLite при исполнении своего модуля.
 * До этой границы доступны команды первого запуска, проверка, восстановление
 * и предмиграционная копия; HTTP-граф ещё не загружен.
 *
 * Отсутствие файла — не ошибка: все переменные опциональны, а секреты вроде
 * TBANK_TOKEN проверяются точечно там, где нужны (tbank/tbank.config.ts).
 */
import { fromAppRoot } from './app-paths';
import { resolve } from 'node:path';

export const settingsFile = process.env['ENV_FILE'] ?? (process.env['DATA_DIR']
  ? resolve(process.env['DATA_DIR'], '.env') : fromAppRoot('.env'));
// Launcher передаёт происхождение значения до своей ранней загрузки .env.
export const tokenFromEnvironment = process.env['PORTFOLIO_TOKEN_FROM_ENV'] === '1' ||
  (process.env['PORTFOLIO_TOKEN_FROM_ENV'] === undefined && Object.hasOwn(process.env, 'TBANK_TOKEN'));

try {
  // Путь абсолютный (app-paths.ts): относительный '.env' нашёлся бы только при
  // запуске из корня workspace.
  process.loadEnvFile(settingsFile);
} catch {
  // .env нет — работаем на значениях по умолчанию
}
