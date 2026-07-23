import { Module } from '@nestjs/common';
import { DrizzleModule } from './db/drizzle.module';
import { OperationsModule } from './modules/operations/operations.module';
import { PortfoliosModule } from './modules/portfolios/portfolios.module';

/**
 * Корневой модуль. В Фазах 2–4 добавляются модули trades, import, quotes
 * (см. docs/04-roadmap.md и CLAUDE.md §2).
 */
@Module({
  imports: [DrizzleModule, OperationsModule, PortfoliosModule],
})
export class AppModule {}
