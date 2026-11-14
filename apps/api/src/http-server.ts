import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app/app.module';
import { APP_ROOT } from './app-paths';
import { resolveDbPath } from './db/db-path';
import { MIGRATIONS_FOLDER, runMigrations } from './db/run-migrations';
import { assertSpaReady, serveSpa } from './serve-spa';
import { sqlite } from './db/client';
import { registerDataHttp } from './data-management/data-http';
import { DataGateInterceptor } from './data-management/data-gate';

/**
 * Импорт текстовых брокерских отчётов приходит одним JSON-телом,
 * поэтому дефолтного лимита Fastify в 1 МиБ не
 * хватает: отчёт за год его перебирает.
 */
const BODY_LIMIT = 25 * 1024 * 1024;

/**
 * Точка входа бэкенда: NestJS поверх Fastify-адаптера (CLAUDE.md §1).
 */
export async function startHttp(unlockProfile: () => void): Promise<void> {
  // До поднятия HTTP: контроллеры не должны увидеть БД со старой схемой.
  runMigrations();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: BODY_LIMIT }),
  );
  app.setGlobalPrefix('api');
  app.useGlobalInterceptors(new DataGateInterceptor());
  await registerDataHttp(app.getHttpAdapter().getInstance(), sqlite, MIGRATIONS_FOLDER);

  // CORS нужен только в режиме разработки, где фронт живёт на отдельном порту.
  // Когда бэкенд раздаёт SPA сам, origin общий и заголовки ни на что не влияют.
  app.enableCors({
    origin: process.env['CORS_ORIGIN'] ?? 'http://localhost:4200',
    credentials: true,
  });

  const spaEnabled = serveSpa(app);
  if (process.env['APP_INSTALLED'] === '1' && !spaEnabled) {
    throw new Error('Установленная версия требует собранный интерфейс');
  }
  if (process.env['APP_INSTALLED'] === '1') assertSpaReady();
  // HTTP начинает принимать запросы только после миграций и регистрации SPA.
  app
    .getHttpAdapter()
    .getInstance()
    .get('/api/health', (_request, reply) => {
      try {
        sqlite.prepare('SELECT 1').get();
        if (spaEnabled) assertSpaReady();
      } catch {
        return reply.status(503).send({ status: 'unavailable' });
      }
      return reply.send({
        status: 'ok', spa: spaEnabled,
        instance: process.env['APP_INSTANCE_ID'],
        version: process.env['APP_VERSION'],
        build: process.env['APP_BUILD'],
      });
    });
  app.enableShutdownHooks(['SIGTERM', 'SIGINT', 'SIGHUP']);
  // Закрываем БД после остановки HTTP и завершения запросов Fastify.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onClose', async () => {
      if (sqlite.open) sqlite.close();
      unlockProfile();
    });

  const port = process.env['PORT'] ? Number(process.env['PORT']) : 3000;
  // Авторизации в API нет, поэтому по умолчанию слушаем только loopback: на
  // 0.0.0.0 портфель читал бы и правил любой в той же сети (кафе, офис).
  // В контейнере, где снаружи ходят через проброс порта, — API_HOST=0.0.0.0.
  // Не HOST: в tcsh и части CI она уже экспортирована и содержит имя машины —
  // API молча открылся бы в сеть.
  const host = process.env['API_HOST'] ?? '127.0.0.1';
  await app.listen(port, host);

  // Пути в логе — чтобы при запуске из фонового сервиса было сразу видно,
  // с каким корнем и какой БД приложение работает.
  if (spaEnabled) {
    console.log(`Приложение: http://localhost:${port}`);
  }
  console.log(`API запущен на http://localhost:${port}/api`);
  console.log(`Корень проекта: ${APP_ROOT}`);
  console.log(`База данных:    ${resolveDbPath()}`);
}
