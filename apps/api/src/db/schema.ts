import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * Схема БД по docs/02-data-model.md. SQLite сейчас → PostgreSQL в SaaS (CLAUDE.md §1).
 *
 * Деньги и количества хранятся как TEXT (десятичная строка), а не REAL/number —
 * иначе теряется точность (CLAUDE.md §11, docs/01-tech-stack.md §4). Парсинг —
 * через decimal.js в движке @core.
 */

/** Торговые системы/стратегии: Верников, Верников_трейдинг, Трейдинг_крипта */
export const systems = sqliteTable('systems', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  color: text('color'),
});

/** Портфели / брокерские счета */
export const portfolios = sqliteTable('portfolios', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  broker: text('broker').notNull(),
  baseCurrency: text('base_currency').notNull().default('RUB'),
});

/** Справочник инструментов */
export const instruments = sqliteTable('instruments', {
  id: text('id').primaryKey(),
  ticker: text('ticker').notNull(),
  type: text('type', {
    enum: ['Stock', 'Bond', 'ETF', 'Currency', 'Crypto', 'Cash'],
  }).notNull(),
  currency: text('currency').notNull(),
  isin: text('isin'),
  name: text('name'),
  marketSource: text('market_source', {
    enum: ['moex', 'cbr', 'binance', 'manual'],
  })
    .notNull()
    .default('manual'),
});

/** Журнал операций — единственная таблица, куда пишет пользователь/импорт */
export const operations = sqliteTable('operations', {
  id: text('id').primaryKey(),
  date: text('date').notNull(), // YYYY-MM-DD
  systemId: text('system_id')
    .notNull()
    .references(() => systems.id),
  portfolioId: text('portfolio_id')
    .notNull()
    .references(() => portfolios.id),
  instrumentId: text('instrument_id').references(() => instruments.id),
  operationType: text('operation_type', {
    enum: [
      'Deposit',
      'Withdraw',
      'Buy',
      'Sell',
      'Dividend',
      'Coupon',
      'Tax',
      'Fee',
      'Transfer',
    ],
  }).notNull(),
  quantity: text('quantity').notNull(),
  price: text('price').notNull(),
  fee: text('fee').notNull().default('0'),
  fxRate: text('fx_rate').notNull().default('1'),
  currency: text('currency').notNull(),
  transferGroup: text('transfer_group'),
  tradeId: text('trade_id'),
  note: text('note'),
  brokerRef: text('broker_ref'),
  importBatchId: text('import_batch_id'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export type SystemRow = typeof systems.$inferSelect;
export type PortfolioRow = typeof portfolios.$inferSelect;
export type InstrumentRow = typeof instruments.$inferSelect;
export type OperationRow = typeof operations.$inferSelect;
export type NewOperationRow = typeof operations.$inferInsert;
