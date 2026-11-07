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
    enum: ['Stock', 'Bond', 'ETF', 'Currency', 'Crypto', 'Cash', 'Future'],
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
  // время сделки «ЧЧ:ММ:СС» (необязательно): порядок сделок внутри дня
  executedAt: text('executed_at'),
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
  /**
   * Валюта ЦЕНЫ — та, в которой её отдал источник, а не валюта инструмента.
   * У замещающих облигаций цена приходит в валюте номинала (USD), и курс
   * пересчёта в рубли надо брать по ней.
   */
  currency: text('currency').notNull(),
  /**
   * НКД на одну бумагу; null — инструмент без накопленного купона.
   * Биржа котирует облигации «чисто», брокер показывает стоимость с НКД —
   * без этого поля оценка портфеля занижена тем сильнее, чем ближе купон.
   */
  accruedInterest: text('accrued_interest'),
  /**
   * Валюта НКД — своя, а не `currency`: биржа отдаёт НКД в валюте расчётов режима
   * торгов, а цену в валюте номинала. У замещающих облигаций они расходятся
   * (цена в USD, НКД в рублях), и пересчёт НКД по курсу цены завышал стоимость
   * в десятки раз.
   */
  accruedCurrency: text('accrued_currency'),
  source: text('source', { enum: ['moex', 'cbr', 'binance', 'manual'] }).notNull(),
  asOf: text('as_of').notNull(),
});

/**
 * История цен — факты, из которых считаются ряды динамики (libs/core/valuation.ts).
 * Одна строка = цена инструмента на дату. Курсы валют лежат здесь же под синтетическим
 * id `fx:USD` (₽ за единицу, валюта цены RUB), поэтому FK на instruments нет: один
 * механизм догрузки и чтения для бумаг и курсов. Приоритет источников при конфликте на
 * одну дату — PRICE_SOURCE_PRIORITY в @core (единственное место политики).
 * Валюта цены и НКД с валютой — как в quotes (у замещающих облигаций они разные).
 */
export const priceHistory = sqliteTable(
  'price_history',
  {
    instrumentId: text('instrument_id').notNull(),
    date: text('date').notNull(), // YYYY-MM-DD
    price: text('price').notNull(),
    currency: text('currency').notNull(),
    accruedInterest: text('accrued_interest'),
    accruedCurrency: text('accrued_currency'),
    source: text('source', {
      enum: ['moex', 'cbr', 'binance', 'broker-report', 'snapshot', 'manual'],
    }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.date] })],
);
export type PriceHistoryRow = typeof priceHistory.$inferSelect;

export type SystemRow = typeof systems.$inferSelect;
export type PortfolioRow = typeof portfolios.$inferSelect;
export type InstrumentRow = typeof instruments.$inferSelect;
export type OperationRow = typeof operations.$inferSelect;
export type NewOperationRow = typeof operations.$inferInsert;
export type QuoteRow = typeof quotes.$inferSelect;

/**
 * Вариационная маржа по фьючерсу из отчёта брокера — ТОЛЬКО для сверки с результатом
 * движка (libs/core/futures-settlement.ts), в P&L и в журнал операций не попадает.
 * Привязана к счёту (портфелю) и инструменту, а не к торговой системе. Upsert по
 * (портфель, инструмент, дата конца периода): повторный импорт отчёта перезаписывает.
 */
export const futuresSettlements = sqliteTable(
  'futures_settlements',
  {
    portfolioId: text('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    instrumentId: text('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    /** конец периода отчёта, YYYY-MM-DD */
    date: text('date').notNull(),
    /** начало периода отчёта; null — в шапке не нашли */
    periodFrom: text('period_from'),
    vmPeriod: text('vm_period').notNull(),
    vmPlanned: text('vm_planned').notNull(),
    qtyStart: text('qty_start').notNull().default('0'),
    markStart: text('mark_start'),
    markEnd: text('mark_end'),
    source: text('source').notNull().default('broker-report'),
  },
  (t) => [primaryKey({ columns: [t.portfolioId, t.instrumentId, t.date] })],
);
export type FuturesSettlementRow = typeof futuresSettlements.$inferSelect;

/**
 * Аннотации исполнения 1:1 к операциям (libs/core/annotations.ts): тег (причина
 * входа/выхода) и сигнальная цена, от которой считается проскальзывание. Отдельная
 * таблица, чтобы журнал операций не засорялся полями одной системы. Комиссии здесь
 * нет сознательно: факт комиссии — в отчёте брокера, а не в выгрузке терминала.
 */
export const operationAnnotations = sqliteTable('operation_annotations', {
  operationId: text('operation_id')
    .primaryKey()
    .references(() => operations.id, { onDelete: 'cascade' }),
  tag: text('tag'),
  /** сигнальная цена, ₽ за контракт (десятичная строка); null — не задана */
  signalPrice: text('signal_price'),
  /** идентификатор парсера, из выгрузки которого пришла аннотация (quik-trades) */
  source: text('source').notNull(),
  importedAt: text('imported_at').notNull(),
});
export type OperationAnnotationRow = typeof operationAnnotations.$inferSelect;
