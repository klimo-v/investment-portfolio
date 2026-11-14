import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
// Импорт нужен и в рантайме (плагин), и для типов: он добавляет reply.sendFile.
import '@fastify/static';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { fromAppRoot } from './app-paths';

/**
 * Каталог собранного фронтенда. По умолчанию — результат `nx build web` в этом
 * же workspace; STATIC_ROOT перекрывает (деплой с другой раскладкой файлов).
 */
export function resolveStaticRoot(): string {
  return fromAppRoot(process.env['STATIC_ROOT'] ?? 'dist/apps/web/browser');
}

/** Проверяем index и локальные JS/CSS запуска, включая modulepreload Angular. */
export function assertSpaReady(): void {
  const root = resolveStaticRoot();
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    for (const attribute of tag[0].matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
      const url = new URL(attribute[2], 'http://spa.local/');
      if (url.origin !== 'http://spa.local' || !/\.(?:js|css)$/i.test(url.pathname)) continue;
      const file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      const path = relative(root, file);
      if (path.startsWith('..') || !statSync(file).isFile()) {
        throw new Error(`Недоступен файл запуска SPA: ${url.pathname}`);
      }
      accessSync(file, constants.R_OK);
    }
  }
}

/**
 * Раздача SPA тем же процессом, что и API.
 *
 * Это и есть режим «пользоваться»: одно приложение на одном порту, без
 * dev-прокси и без CORS (запросы к /api идут на тот же origin). Режим
 * «разрабатывать» не меняется — там фронт поднимает ng serve на 4200, сборки
 * в dist нет, и статика просто не регистрируется.
 *
 * Возвращает true, если раздача включена.
 */
export function serveSpa(app: NestFastifyApplication): boolean {
  const root = resolveStaticRoot();
  if (!existsSync(join(root, 'index.html'))) {
    return false;
  }

  // wildcard: false — плагин регистрирует маршрут на каждый реальный файл и
  // оставляет свободным '/*', который занимает обработчик ниже. Перехватить
  // ненайденное через setNotFoundHandler нельзя: его уже занял Nest.
  app.useStaticAssets({ root, wildcard: false });

  app.getHttpAdapter().getInstance().get('/*', (request, reply) => {
    // Роутинг у Angular клиентский: прямой заход на /operations — не файл на
    // диске, поэтому отдаём index.html, а адрес разбирает уже фронтенд.
    // Конкретные маршруты (файлы статики и /api/... от Nest) специфичнее
    // '/*' и разбираются раньше, сюда не попадают.
    const pathname = new URL(request.url, 'http://spa.local').pathname;
    if (pathname.startsWith('/api') || extname(pathname)) {
      // API и отсутствующие файлы не должны получать HTML клиентского роутера:
      // иначе сломанный JS маскируется успешным ответом index.html.
      return reply.status(404).send({ statusCode: 404, message: 'Not Found' });
    }
    return reply.sendFile('index.html');
  });

  return true;
}
