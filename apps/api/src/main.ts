import 'reflect-metadata';
// Первым — до графа модулей: db/client.ts открывает БД по DB_PATH на верхнем уровне модуля
import './load-env';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app/app.module';
import { APP_ROOT } from './app-paths';
import { resolveDbPath } from './db/db-path';
import { runMigrations } from './db/run-migrations';

/**
 * Точка входа бэкенда: NestJS поверх Fastify-адаптера (CLAUDE.md §1).
 */
async function bootstrap() {
  // До поднятия HTTP: контроллеры не должны увидеть БД со старой схемой.
  runMigrations();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.setGlobalPrefix('api');
  app.enableCors({ origin: 'http://localhost:4200', credentials: true });

  const port = process.env['PORT'] ? Number(process.env['PORT']) : 3000;
  await app.listen(port, '0.0.0.0');
  // Пути в логе — чтобы при запуске из фонового сервиса было сразу видно,
  // с каким корнем и какой БД приложение работает.
  console.log(`API запущен на http://localhost:${port}/api`);
  console.log(`Корень проекта: ${APP_ROOT}`);
  console.log(`База данных:    ${resolveDbPath()}`);
}

bootstrap();
