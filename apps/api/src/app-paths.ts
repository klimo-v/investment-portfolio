import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Корень приложения — база для относительных путей (`.env`, `data/portfolio.sqlite`).
 *
 * Раньше они резолвились от `process.cwd()`, поэтому бэкенд работал только при
 * запуске из корня workspace: из любого другого каталога он не находил `.env` и
 * молча создавал рядом пустую БД. Фоновому сервису и ярлыку рабочий каталог не
 * навяжешь, поэтому корень вычисляется от расположения самого кода.
 *
 * `APP_ROOT` в окружении перекрывает автоопределение — понадобится при деплое,
 * где файлов workspace рядом уже нет.
 */
function detectAppRoot(): string {
  const explicit = process.env['APP_ROOT'];
  if (explicit) {
    return resolve(explicit);
  }

  // Вверх по дереву до каталога с nx.json — он лежит только в корне workspace.
  // Работает одинаково для бандла (dist/apps/api/main.js) и для tsx-скриптов
  // миграций и сидов (apps/api/src/db/*.ts).
  for (let dir = __dirname; ; ) {
    if (existsSync(join(dir, 'nx.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return process.cwd();
    }
    dir = parent;
  }
}

export const APP_ROOT = detectAppRoot();

/**
 * Абсолютный путь от корня приложения. Аргумент, который уже абсолютный,
 * возвращается как есть — так `DB_PATH=/куда/угодно.sqlite` продолжает работать.
 */
export function fromAppRoot(...segments: string[]): string {
  return resolve(APP_ROOT, ...segments);
}
