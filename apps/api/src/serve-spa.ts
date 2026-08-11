import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
    if (request.url.startsWith('/api')) {
      // Несуществующий /api/* обязан остаться честным 404: получив HTML вместо
      // JSON, фронт свалится с невнятной ошибкой разбора.
      return reply.status(404).send({ statusCode: 404, message: 'Not Found' });
    }
    return reply.sendFile('index.html');
  });

  return true;
}
