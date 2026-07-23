import { Module } from '@nestjs/common';
import { DrizzleModule } from './db/drizzle.module';
import { OperationsModule } from './modules/operations/operations.module';
import { PortfoliosModule } from './modules/portfolios/portfolios.module';
import { ImportModule } from './modules/import/import.module';

/**
 * Корневой модуль. В Фазе 4 добавляется модуль quotes
 * (см. docs/04-roadmap.md и CLAUDE.md §2).
 */
@Module({
  imports: [DrizzleModule, OperationsModule, PortfoliosModule, ImportModule],
})
export class AppModule {}
