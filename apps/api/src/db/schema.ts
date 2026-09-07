import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
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
 * снимок в день (date — первичный ключ, upsert), пишется по кнопке «Сделать
 * снимок» на дашборде. Даёт линию динамики стоимости, которой нет при разовом
 * взгляде на текущие Вложено/Текущая стоимость/P&L.
 */
export const portfolioSnapshots = sqliteTable('portfolio_snapshots', {
  date: text('date').primaryKey(), // YYYY-MM-DD
  investedRub: text('invested_rub').notNull(),
  currentValueRub: text('current_value_rub').notNull(),
  pnlRub: text('pnl_rub').notNull(),
  dividendsRub: text('dividends_rub').notNull(),
});

/**
 * Снимок стоимости отдельного инструмента на дату — разбивка агрегатного снимка
 * по инструментам для графика «Стоимость инструментов во времени» на дашборде.
 * Пишется вместе с агрегатом в SnapshotsService.capture() — по кнопке «Сделать
 * снимок» на дашборде. Историю задним числом не реконструируем: дневных цен по
 * каждой бумаге у нас нет, есть только текущая котировка.
 * Составной ключ (date, instrument_id) — один снимок инструмента в день, upsert.
 */
export const snapshotPositions = sqliteTable(
  'snapshot_positions',
  {
    date: text('date').notNull(), // YYYY-MM-DD
    instrumentId: text('instrument_id')
      .notNull()
      .references(() => instruments.id),
    valueRub: text('value_rub').notNull(), // рыночная стоимость держимого остатка в RUB
    quantity: text('quantity').notNull(), // остаток на дату (для тултипа/отладки)
  },
  (t) => [primaryKey({ columns: [t.date, t.instrumentId] })],
);

/**
 * Журнал ретро-изменений журнала операций, которые портят УЖЕ снятые снимки.
 *
 * Снимок кумулятивен: на дату захвата S он суммирует весь журнал операций, какой бы
 * датой операции ни были помечены. Значит правка/удаление операции с датой D делает
 * недостоверным каждый снимок с date >= D — а пересчитать его не из чего, дневных цен
 * по каждой бумаге в системе нет. Раньше такую историю просто стирали целиком; теперь
 * она сохраняется, а сюда пишется строка «что именно изменилось» — её показывает
 * иконка-предупреждение рядом с графиком на дашборде.
 *
 * acknowledged_at — «пользователь это видел»: предупреждение гаснет, история остаётся.
 */
export const snapshotInvalidations = sqliteTable('snapshot_invalidations', {
  id: text('id').primaryKey(),
  /** когда произошло изменение журнала (datetime SQLite, UTC) */
  at: text('at')
    .notNull()
    .default(sql`(datetime('now'))`),
  kind: text('kind', {
    enum: ['add', 'delete', 'reassign', 'merge', 'import-commit', 'import-rollback'],
  }).notNull(),
  /** дата затронутой операции (YYYY-MM-DD) — снимки с этой даты под вопросом */
  operationDate: text('operation_date').notNull(),
  /** человекочитаемое описание для таблицы в модалке: «Sell 10 SBER» */
  description: text('description').notNull(),
  /** тикер, если изменение про один инструмент; null у батчей (импорт, откат) */
  ticker: text('ticker'),
  /** сколько операций затронуто — у батчевых изменений больше одной */
  affectedCount: integer('affected_count').notNull().default(1),
  /** null — предупреждение ещё не просмотрено */
  acknowledgedAt: text('acknowledged_at'),
});

export type SystemRow = typeof systems.$inferSelect;
export type PortfolioRow = typeof portfolios.$inferSelect;
export type InstrumentRow = typeof instruments.$inferSelect;
export type OperationRow = typeof operations.$inferSelect;
export type NewOperationRow = typeof operations.$inferInsert;
export type QuoteRow = typeof quotes.$inferSelect;
export type SnapshotRow = typeof portfolioSnapshots.$inferSelect;
export type SnapshotPositionRow = typeof snapshotPositions.$inferSelect;
export type SnapshotInvalidationRow = typeof snapshotInvalidations.$inferSelect;
