import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Вызывается только вложенным Node из start.sh. Пользовательское окружение
// читается раньше импорта сервера, который открывает SQLite на уровне модуля.
const resources = dirname(fileURLToPath(import.meta.url));
// После аварии меню не оставляем бесхозный сервер. Launcher — прямой потомок
// Swift; после его SIGKILL ядро меняет ppid. Сигнал проходит штатный forward/wait.
const owner = Number(process.env.PORTFOLIO_OWNER_PID);
if (Number.isSafeInteger(owner) && owner > 1) {
  setInterval(() => {
    if (process.ppid !== owner) process.kill(process.pid, 'SIGTERM');
  }, 500).unref();
}
process.env.APP_ROOT = resources;
process.env.DATA_DIR = resolve(process.env.DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'Investment Portfolio'));
process.env.ENV_FILE ??= join(process.env.DATA_DIR, '.env');
process.env.PORTFOLIO_TOKEN_FROM_ENV = Object.hasOwn(process.env, 'TBANK_TOKEN') ? '1' : '0';
try { process.loadEnvFile(process.env.ENV_FILE); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
// Эти параметры установлены launcher-ом и не могут быть расширены через .env.
process.env.APP_INSTALLED = '1';
process.env.API_HOST = '127.0.0.1';
process.env.STATIC_ROOT = join(resources, 'web');
// Обёртка задаёт CA до запуска второго Node и ждёт завершения сервера.
process.argv = [process.execPath, join(resources, 'scripts/run-with-certs.mjs'), 'node', join(resources, 'server/main.js'), ...process.argv.slice(2)];
await import('./scripts/run-with-certs.mjs');
