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
    enum: ['add', 'delete', 'reassign', 'merge', 'import-commit', 'import-rollback', 'strategy-sync'],
  }).notNull(),
  /** дата затронутой операции (YYYY-MM-DD) — снимки с этой даты под вопросом */
  operationDate: text('operation_date').notNull(),
  /** человекочитаемое описание для таблицы в модалке: «Продажа 10 SBER удалена» */
  description: text('description').notNull(),
  /** тикер, если изменение про один инструмент; null у батчей (импорт, откат) */
  ticker: text('ticker'),
  /** сколько операций затронуто — у батчевых изменений больше одной */
  affectedCount: integer('affected_count').notNull().default(1),
  /** null — предупреждение ещё не просмотрено */
  acknowledgedAt: text('acknowledged_at'),
});

/* ------------------------------------------------------------------ срез «ЮВ1» (мост QUIK)
 *
 * Отдельный срез для срочного рынка: фьючерсы, шорт, вариационная маржа и ГО в модели
 * `operations` не живут (docs/yv1-bridge.md). Существующие таблицы не затронуты.
 */

/**
 * Снимки моста: по строке на запуск `quik_snapshot.lua` (qsnap_index.csv). Строки
 * нецелых снимков тоже хранятся — чтобы их было видно в списке, — но их сырьё в
 * `qsnap_raw` не попадает и в расчёт не идёт.
 */
export const qsnapSnapshots = sqliteTable('qsnap_snapshots', {
  snapId: text('snap_id').primaryKey(), // ГГГГММДД_ЧЧММСС
  /**
   * Пометка происхождения: портфель стратегии, которая импортировала снимок (null — на момент
   * импорта счёт не был привязан). Снимок описывает счёт целиком и в расчёт стратегий входит
   * независимо от этого поля.
   */
  portfolioId: text('portfolio_id').references(() => portfolios.id),
  localTime: text('local_time').notNull(), // МСК, YYYY-MM-DD HH:MM:SS
  serverTime: text('server_time').notNull(), // время сервера QUIK без даты, как есть
  serverTimeEnd: text('server_time_end').notNull(),
  tradeDate: text('trade_date').notNull(), // ISO
  connected: integer('connected').notNull(),
  quikVersion: text('quik_version').notNull(),
  scriptVersion: text('script_version').notNull(),
  status: text('status').notNull(),
  rawLines: integer('raw_lines').notNull(),
  rawBytes: integer('raw_bytes').notNull(),
  floatIds: integer('float_ids').notNull(),
  counts: text('counts').notNull(),
  errors: text('errors').notNull(),
  /** local_time − server_time, секунды: диагностика часов, во времена сделок не вычитается */
  clockSkewSec: integer('clock_skew_sec'),
  /** 1 — целый (status=ok, raw_lines сошлось, float_ids=0) */
  complete: integer('complete').notNull(),
  /** почему не целый; пусто у целого */
  reasons: text('reasons').notNull().default(''),
  importedAt: text('imported_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

/**
 * Сырой слой: ровно то, что лежит в qsnap_raw.csv (snap_id, table, row, field, value),
 * только целые снимки. Любой итог прослеживается до этих строк. Значения — текстом,
 * 19-значные номера сделок не теряют разрядов.
 */
export const qsnapRaw = sqliteTable(
  'qsnap_raw',
  {
    snapId: text('snap_id')
      .notNull()
      .references(() => qsnapSnapshots.snapId),
    tableName: text('table_name').notNull(),
    rowNo: integer('row_no').notNull(),
    field: text('field').notNull(),
    value: text('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.snapId, t.tableName, t.rowNo, t.field] })],
);

/** Журнал сделок автомата (yv1_trades.csv и его предшественники) — правило принадлежности сделки ТС */
export const yv1AutomatTrades = sqliteTable('yv1_automat_trades', {
  /** Номер сделки глобален на бирже, поэтому остаётся ключом; systemId — чей это журнал */
  tradeNum: text('trade_num').primaryKey(),
  systemId: text('system_id')
    .notNull()
    .references(() => systems.id),
  orderNum: text('order_num'),
  date: text('date').notNull(),
  time: text('time').notNull(),
  contract: text('contract').notNull(),
  side: text('side', { enum: ['B', 'S'] }).notNull(),
  qty: text('qty').notNull(),
  price: text('price').notNull(),
  reason: text('reason').notNull(),
  refPrice: text('ref_price'),
  slipRub: text('slip_rub'),
  brokerFeeQuik: text('broker_fee_quik'),
  exchangeFee: text('exchange_fee'),
  clearingFee: text('clearing_fee'),
  techCenterFee: text('tech_center_fee'),
  sourceFile: text('source_file').notNull(),
});

/** Итоги дней, сигналы и логи автомата: по строке на дату, содержимое — JSON разобранной записи */
export const yv1AutomatDays = sqliteTable(
  'yv1_automat_days',
  {
    systemId: text('system_id')
      .notNull()
      .references(() => systems.id),
    date: text('date').notNull(),
    payload: text('payload').notNull(),
  },
  (t) => [primaryKey({ columns: [t.systemId, t.date] })],
);
export const yv1AutomatSignals = sqliteTable(
  'yv1_automat_signals',
  {
    systemId: text('system_id')
      .notNull()
      .references(() => systems.id),
    date: text('date').notNull(),
    payload: text('payload').notNull(),
  },
  (t) => [primaryKey({ columns: [t.systemId, t.date] })],
);
export const yv1AutomatLogs = sqliteTable(
  'yv1_automat_logs',
  {
    systemId: text('system_id')
      .notNull()
      .references(() => systems.id),
    date: text('date').notNull(),
    payload: text('payload').notNull(),
  },
  (t) => [primaryKey({ columns: [t.systemId, t.date] })],
);

/** Настройки среза: начальный капитал (знаменатель), округление комиссии, ставка по долгу, масштаб бэктеста */
export const yv1Settings = sqliteTable(
  'yv1_settings',
  {
    systemId: text('system_id')
      .notNull()
      .references(() => systems.id),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.systemId, t.key] })],
);

/**
 * Конфигурация стратегии: связывает торговую систему со счётом (портфелем) и источником
 * данных. Одна система — один конфиг. `adapter` выбирает код, который читает источник
 * (сейчас единственный — `quik-bridge`), `params` — его параметры (JSON; расписание циклов,
 * комиссии, допуски — см. libs/core strategy-manifest). `portfolioId` null — счёт не привязан.
 */
export const strategyConfigs = sqliteTable('strategy_configs', {
  systemId: text('system_id')
    .primaryKey()
    .references(() => systems.id),
  portfolioId: text('portfolio_id').references(() => portfolios.id),
  adapter: text('adapter').notNull(),
  params: text('params').notNull().default('{}'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

/**
 * Лента реализованного результата стратегии по дням — то, что агрегатор портфеля
 * добавляет к результату по операциям. Пересобирается адаптером при каждом refresh
 * (производные данные, не источник правды). Портфель берётся из `strategy_configs`
 * на момент чтения, поэтому привязка счёта не требует перезаписи ленты.
 * Деньги — десятичные строки.
 */
export const strategyDailyResults = sqliteTable(
  'strategy_daily_results',
  {
    systemId: text('system_id')
      .notNull()
      .references(() => systems.id),
    date: text('date').notNull(), // YYYY-MM-DD — дата закрытия циклов
    pricePnlRub: text('price_pnl_rub').notNull(),
    costsRub: text('costs_rub').notNull(),
    debtInterestRub: text('debt_interest_rub').notNull(),
    netRub: text('net_rub').notNull(),
    cycles: integer('cycles').notNull(),
  },
  (t) => [primaryKey({ columns: [t.systemId, t.date] })],
);

export type SystemRow = typeof systems.$inferSelect;
export type PortfolioRow = typeof portfolios.$inferSelect;
export type InstrumentRow = typeof instruments.$inferSelect;
export type OperationRow = typeof operations.$inferSelect;
export type NewOperationRow = typeof operations.$inferInsert;
export type QuoteRow = typeof quotes.$inferSelect;
export type SnapshotRow = typeof portfolioSnapshots.$inferSelect;
export type SnapshotPositionRow = typeof snapshotPositions.$inferSelect;
export type SnapshotInvalidationRow = typeof snapshotInvalidations.$inferSelect;
export type QsnapSnapshotRow = typeof qsnapSnapshots.$inferSelect;
export type StrategyConfigRow = typeof strategyConfigs.$inferSelect;
