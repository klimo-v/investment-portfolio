import 'reflect-metadata';
// Первым — до графа модулей: db/client.ts открывает БД по DB_PATH на верхнем уровне модуля
import './load-env';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app/app.module';
import { APP_ROOT } from './app-paths';
import { resolveDbPath } from './db/db-path';
import { runMigrations } from './db/run-migrations';
import { serveSpa } from './serve-spa';

/**
 * Импорт брокерских отчётов приходит одним JSON-телом, xlsx — внутри него в
 * base64 (import.service.ts), поэтому дефолтного лимита Fastify в 1 МиБ не
 * хватает: отчёт за год его перебирает.
 */
const BODY_LIMIT = 25 * 1024 * 1024;

/**
 * Точка входа бэкенда: NestJS поверх Fastify-адаптера (CLAUDE.md §1).
 */
async function bootstrap() {
  // До поднятия HTTP: контроллеры не должны увидеть БД со старой схемой.
  runMigrations();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: BODY_LIMIT }),
  );
  app.setGlobalPrefix('api');

  // CORS нужен только в режиме разработки, где фронт живёт на отдельном порту.
  // Когда бэкенд раздаёт SPA сам, origin общий и заголовки ни на что не влияют.
  app.enableCors({
    origin: process.env['CORS_ORIGIN'] ?? 'http://localhost:4200',
    credentials: true,
  });

  const spaEnabled = serveSpa(app);

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

bootstrap();
