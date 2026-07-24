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
  /**
   * Признак счёта из отчёта брокера (напр. торговый код ИИС) — persisted-маппинг
   * «счёт отчёта → портфель» (docs/04-roadmap.md §3.1). Заполняется автоматически
   * при импорте: пользователь один раз выбирает портфель для незнакомого счёта,
   * дальше он резолвится сам. Nullable — не у всех портфелей есть импортированные
   * HTML-отчёты.
   */
  accountRef: text('account_ref').unique(),
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

/** Кэш котировок (текущие цены инструментов) */
export const quotes = sqliteTable('quotes', {
  instrumentId: text('instrument_id')
    .primaryKey()
    .references(() => instruments.id),
  price: text('price').notNull(),
  currency: text('currency').notNull(),
  source: text('source', { enum: ['moex', 'cbr', 'binance', 'manual'] }).notNull(),
  asOf: text('as_of').notNull(),
});

/**
 * Снимки стоимости портфеля во времени (docs/04-roadmap.md, Фаза 5) — один
 * снимок в день (date — первичный ключ, upsert), пишется при обновлении
 * котировок. Даёт линию динамики стоимости, которой нет при разовом взгляде
 * на текущие Вложено/Текущая стоимость/P&L.
 */
export const portfolioSnapshots = sqliteTable('portfolio_snapshots', {
  date: text('date').primaryKey(), // YYYY-MM-DD
  investedRub: text('invested_rub').notNull(),
  currentValueRub: text('current_value_rub').notNull(),
  pnlRub: text('pnl_rub').notNull(),
  dividendsRub: text('dividends_rub').notNull(),
});

export type SystemRow = typeof systems.$inferSelect;
export type PortfolioRow = typeof portfolios.$inferSelect;
export type InstrumentRow = typeof instruments.$inferSelect;
export type OperationRow = typeof operations.$inferSelect;
export type NewOperationRow = typeof operations.$inferInsert;
export type QuoteRow = typeof quotes.$inferSelect;
export type SnapshotRow = typeof portfolioSnapshots.$inferSelect;
