import { Inject, Injectable } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  systems,
  portfolios,
  instruments,
  type SystemRow,
  type PortfolioRow,
  type InstrumentRow,
} from '../../../db/schema';
import { DB } from '../../db/drizzle.module';

/**
 * Справочники: системы, портфели, инструменты (docs/02-data-model.md §2.2–2.4).
 * Нужны фронту для автокомплита в форме ввода операций (Фаза 2).
 */
@Injectable()
export class PortfoliosService {
  constructor(@Inject(DB) private readonly db: BetterSQLite3Database) {}

  listSystems(): SystemRow[] {
    return this.db.select().from(systems).all();
  }

  listPortfolios(): PortfolioRow[] {
    return this.db.select().from(portfolios).all();
  }

  listInstruments(): InstrumentRow[] {
    return this.db.select().from(instruments).all();
  }
}
