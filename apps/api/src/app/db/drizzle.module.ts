import { Global, Module } from '@nestjs/common';
import { db } from '../../db/client';

export const DB = Symbol('DB');

/**
 * Глобальный модуль подключения к БД — провайдер через DI-токен (CLAUDE.md §7, DIP):
 * сервисы зависят от токена DB, а не от конкретного файла клиента.
 */
@Global()
@Module({
  providers: [{ provide: DB, useValue: db }],
  exports: [DB],
})
export class DrizzleModule {}
