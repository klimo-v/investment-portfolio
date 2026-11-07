import { z } from 'zod';

/**
 * Zod-схемы — единый контракт данных для фронта (Signal Forms), бэка (валидация
 * тела запроса) и разбора импорта. См. docs/02-data-model.md и CLAUDE.md §8.
 */

/** Тип инструмента */
export const InstrumentType = z.enum([
  'Stock',
  'Bond',
  'ETF',
  'Currency',
  'Crypto',
  'Cash',
  'Future', // срочный контракт: позиция со знаком (шорт допустим), цена в ₽ за контракт
]);
export type InstrumentType = z.infer<typeof InstrumentType>;

/** Тип операции (все виды из реальных данных пользователя) */
export const OperationType = z.enum([
  'Deposit', // ввод кэша
  'Withdraw', // вывод кэша
  'Buy', // покупка
  'Sell', // продажа
  'Dividend', // дивиденд
  'Coupon', // купон по облигации
  'Tax', // налог
  'Fee', // отдельная комиссия
  'Transfer', // перевод между портфелями
]);
export type OperationType = z.infer<typeof OperationType>;

/**
 * Деньги/количество передаём строкой, чтобы не терять точность на JSON-числах.
 * Внутри движка парсим через decimal.js. См. CLAUDE.md §11 (деньги не во float).
 */
const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'Ожидается десятичное число в виде строки');

/** Операция журнала — то единственное, что вводится/импортируется */
export const OperationSchema = z.object({
  id: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD'),
  systemId: z.string().min(1),
  portfolioId: z.string().min(1),
  instrumentId: z.string().nullable().optional(),
  operationType: OperationType,
  quantity: decimalString,
  price: decimalString,
  fee: decimalString.default('0'),
  fxRate: decimalString.default('1'),
  currency: z.string().min(1),
  transferGroup: z.string().nullish(),
  tradeId: z.string().nullish(),
  note: z.string().nullish(),
  brokerRef: z.string().nullish(),
  /** время сделки «ЧЧ:ММ:СС» — порядок внутри дня (важен для шортов по фьючерсам) */
  executedAt: z.string().regex(/^\d{2}:\d{2}:\d{2}$/, 'Время в формате ЧЧ:ММ:СС').nullish(),
  importBatchId: z.string().nullish(),
});
export type Operation = z.infer<typeof OperationSchema>;

/**
 * Частичное переназначение операции на систему/портфель (docs/04-roadmap.md §3.1 —
 * разбор отчёта, где сделки принадлежат разным системам и/или разным счетам брокера).
 * Хотя бы одно поле обязательно.
 */
export const OperationReassignSchema = z
  .object({
    systemId: z.string().min(1).optional(),
    portfolioId: z.string().min(1).optional(),
  })
  .refine((v) => v.systemId !== undefined || v.portfolioId !== undefined, {
    message: 'Укажите systemId и/или portfolioId',
  });
export type OperationReassign = z.infer<typeof OperationReassignSchema>;

/** Инструмент (справочник) */
export const InstrumentSchema = z.object({
  id: z.string().min(1),
  ticker: z.string().min(1),
  type: InstrumentType,
  currency: z.string().min(1),
  isin: z.string().nullish(),
  name: z.string().nullish(),
  marketSource: z.enum(['moex', 'cbr', 'binance', 'manual']).default('manual'),
});
export type Instrument = z.infer<typeof InstrumentSchema>;

/**
 * Тело запроса на ручную установку цены — для инструментов с marketSource='manual'
 * (нет автоматического провайдера котировок, см. QuotesService), цену вводит
 * пользователь сам вместо того, чтобы бумага молча оставалась без «Тек. цены».
 */
export const ManualPriceSchema = z.object({
  price: decimalString,
});
export type ManualPrice = z.infer<typeof ManualPriceSchema>;

/** Торговая система / стратегия (справочник, docs/02-data-model.md §2.2) */
export const SystemSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().nullish(),
  color: z.string().nullish(),
});
export type System = z.infer<typeof SystemSchema>;

/** Портфель / брокерский счёт (справочник, docs/02-data-model.md §2.3) */
export const PortfolioSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  /**
   * Признак счёта из отчёта брокера (docs/04-roadmap.md §3.1) — заполняется
   * автоматически при импорте, руками не редактируется, поэтому только для чтения.
   */
  accountRef: z.string().nullish(),
});
export type Portfolio = z.infer<typeof PortfolioSchema>;

/** Позиция (вычисляется движком, не вводится руками) */
export const PositionSchema = z.object({
  instrumentId: z.string(),
  ticker: z.string(),
  systemId: z.string(),
  portfolioId: z.string(),
  type: InstrumentType,
  currency: z.string(),
  quantity: decimalString,
  avgBuyPrice: decimalString,
  investedCcy: decimalString,
  investedRub: decimalString,
  realizedPnlRub: decimalString,
  dividendsRub: decimalString,
  couponsRub: decimalString,
  /**
   * Валюта, в которой выражена avgBuyPrice, — валюта сделок. У замещающих
   * облигаций она отличается от `currency` (валюты номинала): номинал в USD,
   * а покупка прошла в рублях.
   */
  avgPriceCurrency: z.string(),
  /** «Чистая» цена с биржи — без НКД, как её котирует рынок */
  currentPrice: decimalString.nullable(),
  /**
   * Валюта currentPrice. Для валютных облигаций это НЕ `currency` сделок:
   * MOEX отдаёт цену в валюте номинала (FACEUNIT). По ней же берётся курс
   * пересчёта в рубли — брать курс валюты инструмента было ошибкой.
   */
  priceCurrency: z.string().nullable(),
  /** Накопленный купонный доход по всему остатку, в рублях; null — не облигация */
  accruedInterestRub: decimalString.nullable(),
  /** Рыночная стоимость остатка: (цена + НКД) × количество × курс */
  currentValueRub: decimalString.nullable(),
  pnlRub: decimalString.nullable(), // реализованный + нереализованный + дивиденды/купоны
});
export type Position = z.infer<typeof PositionSchema>;

/**
 * Метрики эффективности среза портфеля (docs/05-review-usability.md §1) — считаются
 * движком метрик (libs/core/metrics.ts). Один и тот же набор для totals, разреза по
 * системам и по портфелям, чтобы их можно было честно сравнивать между собой
 * (абсолютный P&L в рублях сравнивать нельзя — большой счёт всегда «выигрывает»).
 */
export const EffectivenessSchema = z.object({
  investedRub: z.number(), // вложено = себестоимость держимого остатка (сходится со сделками)
  currentValueRub: z.number(), // рыночная стоимость остатка на сегодня
  realizedPnlRub: z.number(), // зафиксированный результат по проданным частям
  unrealizedPnlRub: z.number(), // бумажная переоценка удерживаемого остатка
  dividendsRub: z.number(), // полученные дивиденды + купоны
  pnlRub: z.number(), // realized + unrealized + dividends
  roiPct: z.number().nullable(), // pnl / invested, %; null если вложено = 0 (всё закрыто)
  dividendYieldPct: z.number().nullable(), // dividends / invested, %
  xirrPct: z.number().nullable(), // годовая денежно-взвешенная доходность, %
});
export type Effectiveness = z.infer<typeof EffectivenessSchema>;

/**
 * Денежный срез портфеля: сколько всего в нём сейчас лежит.
 *
 * Намеренно НЕ часть EffectivenessSchema, хотя туда просилось: та считается ещё и по
 * системам, а денежный остаток по торговой системе бессмысленен — деньги лежат на
 * брокерском СЧЁТЕ (портфеле), а не в стратегии. Плюс Effectiveness — метрики за
 * период, а остаток периода не имеет (только дату, см. cash.ts).
 */
export const CashSchema = z.object({
  cashRub: z.number(), // свободные деньги; отрицательные = журнал неполон (см. cash.ts)
  totalValueRub: z.number(), // всего в портфеле = стоимость позиций + свободные деньги
});
export type Cash = z.infer<typeof CashSchema>;

/**
 * Агрегаты для дашборда (docs/03-ux-plan.md, шаг 4).
 * Логика построения графика — из portfolio_dashboard.html пользователя:
 * помесячные поток (депозиты/выводы) и доход (дивиденды/купоны/реализ. P&L),
 * P&L по системам, breakdown прибыль/убыток по инструментам.
 */
export const DashboardSummarySchema = z.object({
  // временной ряд по месяцам (для комбо-графика)
  timeline: z.array(
    z.object({
      period: z.string(), // YYYY-MM
      flow: z.number(), // поток кэша (депозит + / вывод −)
      income: z.number(), // доход (дивиденды + купоны)
    }),
  ),
  // P&L по системам (столбцы) + метрики эффективности среза
  bySystem: z.array(
    EffectivenessSchema.extend({
      systemId: z.string(),
      name: z.string(),
    }),
  ),
  // то же по портфелям/счетам
  byPortfolio: z.array(
    EffectivenessSchema.extend({
      portfolioId: z.string(),
      name: z.string(),
    }),
  ),
  // breakdown прибыль/убыток по инструментам (бары)
  breakdown: z.array(
    z.object({
      ticker: z.string(),
      pnlRub: z.number(),
    }),
  ),
  totals: EffectivenessSchema,
  cash: CashSchema,
});
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

/** Точка истории бенчмарка (индекс IMOEX) — для линии «Портфель vs рынок» */
export const BenchmarkPointSchema = z.object({
  date: z.string(), // YYYY-MM-DD
  close: z.number(),
});
export type BenchmarkPoint = z.infer<typeof BenchmarkPointSchema>;

/**
 * Ряд стоимости во времени по одному инструменту (для мульти-линейного графика
 * «Стоимость инструментов во времени» на дашборде). Значение — рыночная стоимость
 * держимого остатка в RUB на соответствующую дату из PositionSeries.dates; null —
 * инструмент в эту дату не удерживался или на него не было цены.
 */
export const InstrumentValueSeriesSchema = z.object({
  instrumentId: z.string(),
  ticker: z.string(),
  values: z.array(z.number().nullable()),
});
export type InstrumentValueSeries = z.infer<typeof InstrumentValueSeriesSchema>;

/**
 * Колоночный ряд «стоимость инструментов во времени» (docs/05-review-usability.md).
 * dates — общая ось; instruments — по линии на инструмент; total — сумма стоимостей
 * показанных инструментов; netContributions — накопленный чистый ввод средств
 * (депозиты − выводы) на каждую дату, чтобы отделить рост от довнесения капитала.
 */
export const PositionSeriesSchema = z.object({
  dates: z.array(z.string()), // YYYY-MM-DD, по возрастанию
  instruments: z.array(InstrumentValueSeriesSchema),
  total: z.array(z.number()),
  netContributions: z.array(z.number()),
});
export type PositionSeries = z.infer<typeof PositionSeriesSchema>;

/** Статус сделки: открыта / частично закрыта / закрыта по остатку количества */
export const TradeStatus = z.enum(['Open', 'Partial', 'Closed']);
export type TradeStatus = z.infer<typeof TradeStatus>;

/**
 * Сделка (docs/02-data-model.md §2.5, docs/03-ux-plan.md шаг 2).
 * Не вводится руками — собирается движком из операций одного инструмента:
 * открывается первой покупкой, закрывается когда остаток уходит в ноль.
 */
export const TradeSchema = z.object({
  id: z.string(),
  instrumentId: z.string(),
  ticker: z.string(),
  systemId: z.string(),
  portfolioId: z.string(),
  type: InstrumentType,
  currency: z.string(),
  status: TradeStatus,
  quantity: decimalString, // остаток (0 у закрытой сделки)
  qtyBought: decimalString,
  qtySold: decimalString,
  avgBuyPrice: decimalString,
  investedCcy: decimalString,
  investedRub: decimalString,
  proceedsCcy: decimalString,
  proceedsRub: decimalString,
  realizedPnlCcy: decimalString,
  realizedPnlRub: decimalString,
  dividendsRub: decimalString,
  couponsRub: decimalString,
  /** валюта avgBuyPrice/investedCcy — валюта сделок (см. PositionSchema.avgPriceCurrency) */
  avgPriceCurrency: z.string(),
  currentPrice: decimalString.nullable(),
  /** валюта currentPrice (см. PositionSchema.priceCurrency) */
  priceCurrency: z.string().nullable(),
  /** рыночная стоимость остатка с учётом НКД */
  currentValueRub: decimalString.nullable(),
  pnlRub: decimalString.nullable(), // реализованный + нереализованный + выплаты
  /** направление: у не-фьючерсов всегда Long, у фьючерса — по знаку позиции при открытии */
  direction: z.enum(['Long', 'Short']),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
  /** время открытия «ЧЧ:ММ:СС»; null — у операций нет времени (старые данные) */
  openedTime: z.string().nullable(),
  closedTime: z.string().nullable(),
  /** комиссии всех операций сделки в рублях (уже учтены в realizedPnlRub) */
  feesRub: decimalString,
  /** id операций, из которых собрана сделка — для раскрытия строки в UI */
  operationIds: z.array(z.string()),
});
export type Trade = z.infer<typeof TradeSchema>;

/**
 * Статистика результатов торговой системы (страница «Система», libs/core/performance.ts).
 * Деньги — decimal-строки, безразмерные коэффициенты — number, null — «не определено»
 * (нет данных, деление на ноль). Считается ТОЛЬКО по закрытым сделкам; открытая
 * позиция отражена отдельно (summary.openRealizedRub / unrealizedRub) и в реализованный
 * результат не подмешивается.
 */
const DirectionStatsSchema = z.object({
  count: z.number(),
  wins: z.number(),
  winRatePct: z.number().nullable(),
  netPnlRub: decimalString,
});
export const SystemPerformanceSchema = z.object({
  systemId: z.string(),
  systemName: z.string(),
  summary: z.object({
    /** реализованный результат закрытых сделок, после комиссий */
    netPnlRub: decimalString,
    /** до комиссий: net + комиссии закрытых сделок */
    grossPnlRub: decimalString,
    /** комиссии закрытых сделок */
    feesRub: decimalString,
    /** комиссии всех сделок, включая открытые */
    feesTotalRub: decimalString,
    /** комиссии закрытых / gross, %; null — gross ≤ 0 */
    feeSharePct: z.number().nullable(),
    /** уже зафиксированное по открытым сделкам (комиссии входа, частичные закрытия) */
    openRealizedRub: decimalString,
    /** нереализованный результат открытых сделок по расчётной цене */
    unrealizedRub: decimalString,
    /** net закрытых + openRealized + unrealized */
    totalRub: decimalString,
    openCount: z.number(),
  }),
  trades: z.object({
    closed: z.number(),
    wins: z.number(),
    losses: z.number(),
    breakeven: z.number(),
    winRatePct: z.number().nullable(),
    long: DirectionStatsSchema,
    short: DirectionStatsSchema,
  }),
  quality: z.object({
    avgWinRub: decimalString,
    avgLossRub: decimalString,
    /** ср. выигрыш / |ср. убыток| */
    payoffRatio: z.number().nullable(),
    /** сумма прибылей / сумма убытков */
    profitFactor: z.number().nullable(),
    expectancyRub: decimalString,
    largestWinRub: decimalString,
    largestLossRub: decimalString,
  }),
  streaks: z.object({
    maxWins: z.number(),
    maxLosses: z.number(),
    current: z.object({ kind: z.enum(['win', 'loss']).nullable(), length: z.number() }),
  }),
  risk: z.object({
    maxDrawdownRub: decimalString,
    peakDate: z.string().nullable(),
    troughDate: z.string().nullable(),
    recoveryDate: z.string().nullable(),
    /** от пика до восстановления (или до последней точки, если не восстановилась) */
    drawdownDays: z.number(),
    recoveryFactor: z.number().nullable(),
  }),
  holding: z.object({
    /** true — у всех закрытых сделок есть время, срок точный; иначе считан по датам */
    hasTime: z.boolean(),
    avgHours: z.number().nullable(),
    avgWinHours: z.number().nullable(),
    avgLossHours: z.number().nullable(),
  }),
  ratios: z.object({
    sharpe: z.number().nullable(),
    sortino: z.number().nullable(),
    /** сколько дневных значений вошло в расчёт */
    days: z.number(),
    /** допущения расчёта словами — показываются в подсказке */
    assumptions: z.string(),
  }),
  series: z.object({
    /** кривая эквити: точка на день по дате закрытия + стартовый ноль */
    equity: z.array(
      z.object({ date: z.string(), equityRub: decimalString, drawdownRub: decimalString }),
    ),
    byMonth: z.array(z.object({ period: z.string(), pnlRub: decimalString, trades: z.number() })),
    /** weekday: 1 = понедельник … 7 = воскресенье (по дате закрытия) */
    byWeekday: z.array(z.object({ weekday: z.number(), pnlRub: decimalString, trades: z.number() })),
    histogram: z.array(z.object({ fromRub: decimalString, toRub: decimalString, count: z.number() })),
  }),
});
export type SystemPerformance = z.infer<typeof SystemPerformanceSchema>;

/** Query-параметры GET /api/systems/:systemId/performance (как у operations/summary) */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD');
export const SystemPerformanceQuerySchema = z
  .object({
    portfolioId: z.string().min(1).optional(),
    from: isoDate.optional(),
    till: isoDate.optional(),
  })
  .refine((q) => !q.from || !q.till || q.from <= q.till, {
    message: '`from` не может быть позже `till`',
  });
export type SystemPerformanceQuery = z.infer<typeof SystemPerformanceQuerySchema>;

/**
 * Снимок стоимости портфеля на дату (docs/04-roadmap.md, Фаза 5) — один снимок
 * в день, пишется при обновлении котировок («Обновить цены»). Даёт линию
 * динамики стоимости во времени, которой не хватает при разовом взгляде на
 * «Вложено/Текущая стоимость/P&L» (см. дашборд).
 */
export const SnapshotSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD'),
  investedRub: z.number(),
  currentValueRub: z.number(),
  pnlRub: z.number(),
  dividendsRub: z.number(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** Вид ретро-изменения журнала операций, портящего уже снятые снимки */
export const SnapshotInvalidationKind = z.enum([
  'add',
  'delete',
  'reassign',
  'merge',
  'import-commit',
  'import-rollback',
]);
export type SnapshotInvalidationKind = z.infer<typeof SnapshotInvalidationKind>;

/**
 * Запись журнала «что изменилось после того, как снимки были сняты». Снимок
 * кумулятивен (весь журнал операций на дату захвата), поэтому правка операции задним
 * числом делает недостоверными все снимки с date >= operationDate, а пересчитать их
 * не из чего — дневных цен по каждой бумаге нет. Вместо стирания истории показываем
 * пользователю, что именно изменилось.
 */
export const SnapshotInvalidationSchema = z.object({
  id: z.string(),
  /** когда произошло изменение журнала (datetime, UTC) */
  at: z.string(),
  kind: SnapshotInvalidationKind,
  /** дата затронутой операции — с неё снимки под вопросом */
  operationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD'),
  description: z.string(),
  /** тикер, если изменение про один инструмент; null у батчей (импорт, откат) */
  ticker: z.string().nullable(),
  affectedCount: z.number(),
  /** пользователь уже видел это предупреждение */
  acknowledged: z.boolean(),
});
export type SnapshotInvalidation = z.infer<typeof SnapshotInvalidationSchema>;

/**
 * Достоверность накопленной истории снимков для дашборда. `stale` выводится из
 * наличия НЕпросмотренных записей журнала, `staleSince` — дата первого реально
 * испорченного снимка («снимкам с этой даты доверять нельзя»).
 */
export const SnapshotStalenessSchema = z.object({
  stale: z.boolean(),
  staleSince: z.string().nullable(), // YYYY-MM-DD
  /** все записи журнала, свежие сверху */
  entries: z.array(SnapshotInvalidationSchema),
});
export type SnapshotStaleness = z.infer<typeof SnapshotStalenessSchema>;
