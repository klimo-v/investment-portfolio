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

/**
 * Сверка результата движка с вариационной маржой брокера по фьючерсу
 * (libs/core/futures-settlement.ts). Контроль качества данных, не источник P&L.
 */
export const SettlementCheckSchema = z.object({
  status: z.enum(['ok', 'mismatch', 'unknown']),
  /** движок − брокер, ₽; null при unknown */
  diffRub: decimalString.nullable(),
  engineRub: decimalString.nullable(),
  brokerRub: decimalString,
  /** дата конца периода отчёта, по которому сверяли */
  asOf: z.string(),
  reason: z.string().nullable(),
});
export type SettlementCheckDto = z.infer<typeof SettlementCheckSchema>;

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
  /** сверка с ВМ брокера — только у фьючерсов, по которым импортирован отчёт */
  settlementCheck: SettlementCheckSchema.nullable().default(null),
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
  dividendYieldPct: z.number().nullable(), // dividends / invested, %
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
/**
 * Блок «Исполнение» — появляется только при наличии аннотаций (CSV исполнения).
 * Проскальзывание считается в ядре от сигнальной цены: положительное = потеряли.
 */
const ExecutionSchema = z.object({
  /** сколько исполнений системы имеют аннотацию */
  fills: z.number(),
  /** контрактов/штук, у которых есть сигнальная цена (знаменатель среднего) */
  contractsWithSignal: decimalString,
  totalSlippageRub: decimalString,
  avgSlippagePerContractRub: decimalString.nullable(),
  byTag: z.array(
    z.object({
      tag: z.string().nullable(),
      fills: z.number(),
      contracts: decimalString,
      slippageRub: decimalString,
    }),
  ),
  /** закрытые сделки по тегу входа (тег первого аннотированного исполнения сделки) */
  byEntryTag: z.array(
    z.object({
      tag: z.string().nullable(),
      trades: z.number(),
      wins: z.number(),
      winRatePct: z.number().nullable(),
      netPnlRub: decimalString,
    }),
  ),
});
export type ExecutionStats = z.infer<typeof ExecutionSchema>;

/** Что мешает оценке инструмента на день (см. CarriedReason в valuation.ts) */
export const CarriedPriceSchema = z.object({
  instrumentId: z.string(),
  reason: z.enum(['no-price', 'no-fx', 'carried']),
  /** дата цены, которой воспользовались; null — цены не было */
  priceDate: z.string().nullable(),
});

/** Точка дневного ряда оценки (valuationSeries): деньги — decimal-строки */
export const ValuationPointSchema = z.object({
  date: z.string(),
  investedRub: decimalString,
  marketValueRub: decimalString,
  fixedRub: decimalString,
  unrealizedRub: decimalString,
  totalRub: decimalString,
  carried: z.array(CarriedPriceSchema),
});

const ResultPointSchema = z.object({
  date: z.string(),
  fixedRub: decimalString,
  unrealizedRub: decimalString,
  totalRub: decimalString,
  drawdownRub: decimalString,
  carried: z.array(CarriedPriceSchema),
});

export const SystemPerformanceSchema = z.object({
  execution: ExecutionSchema.nullable().default(null),
  systemId: z.string(),
  systemName: z.string(),
  /**
   * Сверка с вариационной маржой — только по инструментам, которыми в портфеле торгует
   * ОДНА эта система (ВМ привязана к счёту и инструменту; если контракт делят две системы,
   * разделить ВМ между ними нельзя — сверка показывается на странице «Портфель»).
   */
  reconciliation: z
    .array(SettlementCheckSchema.extend({ ticker: z.string(), portfolioId: z.string() }))
    .default([]),
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
    /** дивиденды и купоны по всем сделкам (налог уже удержан брокером) */
    incomeRub: decimalString,
    /** net закрытых + их дивиденды и купоны: «закрытые сделки» целиком */
    closedResultRub: decimalString,
    /** дивиденды и купоны по закрытым сделкам */
    closedIncomeRub: decimalString,
    /** из них по открытым сделкам */
    openIncomeRub: decimalString,
    /** нереализованный + уже зафиксированное (частичные продажи, комиссии) + выплаты по открытым: «открытые позиции» целиком; closedResult + openResult = totalRub */
    openResultRub: decimalString,
    /** net закрытых + openRealized + unrealized + income */
    totalRub: decimalString,
    openCount: z.number(),
  }),
  /** Метрики по закрытым сделкам: качество входов и выходов; базис подписан */
  tradeMetrics: z.object({
    basis: z.string(),
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
    holding: z.object({
      /** true — у всех закрытых сделок есть время, срок точный; иначе считан по датам */
      hasTime: z.boolean(),
      avgHours: z.number().nullable(),
      avgWinHours: z.number().nullable(),
      avgLossHours: z.number().nullable(),
    }),
  }),
  /** Метрики дневной кривой «Результат системы»: просадка, recovery factor, Sharpe, Sortino */
  equityMetrics: z.object({
    basis: z.string(),
    /** сколько дневных изменений вошло в Sharpe/Sortino */
    days: z.number(),
    maxDrawdownRub: decimalString,
    peakDate: z.string().nullable(),
    troughDate: z.string().nullable(),
    recoveryDate: z.string().nullable(),
    /** от пика до восстановления (или до последней точки, если не восстановилась) */
    drawdownDays: z.number(),
    recoveryFactor: z.number().nullable(),
    sharpe: z.number().nullable(),
    sortino: z.number().nullable(),
    /** допущения расчёта словами — показываются в подсказке */
    assumptions: z.string(),
  }),
  series: z.object({
    /** кривая эквити: точка на день по дате закрытия + стартовый ноль */
    equity: z.array(
      z.object({ date: z.string(), equityRub: decimalString, drawdownRub: decimalString }),
    ),
    /** Кривая «Результат системы»: точка на каждый день, зафиксированное + переоценка (valuationSeries) */
    result: z.array(ResultPointSchema),
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
 * Дневной ряд оценки (GET /api/valuation/series): из него строятся ВСЕ графики динамики —
 * стоимость портфеля, стоимость инструментов, кривая системы. Ряд считается из журнала и
 * истории цен на каждый запрос (valuationSeries), в БД не хранится.
 */
export const ValuationSeriesSchema = z.object({
  from: z.string().nullable(),
  till: z.string(),
  groupBy: z.enum(['portfolio', 'system', 'instrument']),
  groups: z.array(
    z.object({
      key: z.string(),
      /** человекочитаемое имя группы: система, портфель или тикер */
      name: z.string(),
      points: z.array(ValuationPointSchema),
    }),
  ),
  /** накопленный чистый ввод средств (депозиты − выводы) по тем же датам, что и точки групп */
  netContributionsRub: z.array(decimalString),
});
export type ValuationSeriesDto = z.infer<typeof ValuationSeriesSchema>;

export const ValuationQuerySchema = z
  .object({
    groupBy: z.enum(['portfolio', 'system', 'instrument']).default('system'),
    systemId: z.string().min(1).optional(),
    portfolioId: z.string().min(1).optional(),
    from: isoDate.optional(),
    till: isoDate.optional(),
  })
  .refine((q) => !q.from || !q.till || q.from <= q.till, {
    message: '`from` не может быть позже `till`',
  });
export type ValuationQuery = z.infer<typeof ValuationQuerySchema>;

// --- Единый расчёт периода: GET /api/performance (libs/core/period-performance.ts) ---

const PerformanceUnavailableSchema = z.enum(['no-capital', 'no-data', 'xirr-undefined']);

/** Доходность за период по одному контуру: результат ₽, TWR, доходность денег, средний капитал */
export const PeriodPerformanceSchema = z.object({
  contour: z.enum(['wealth', 'positions']),
  from: z.string().nullable(),
  till: z.string().nullable(),
  /** день базы (V_start); null — период с первой операции */
  baseDate: z.string().nullable(),
  days: z.number(),
  startValueRub: decimalString,
  endValueRub: decimalString,
  netFlowRub: decimalString,
  resultRub: decimalString,
  breakdown: z.object({
    /** Δ зафиксированного: продажи + выплаты (+ комиссии/расчёты фьючерсов) */
    fixedRub: decimalString,
    payoutsRub: decimalString.nullable(),
    realizedRub: decimalString.nullable(),
    revaluationRub: decimalString,
  }),
  twr: z.object({
    pct: z.number().nullable(),
    series: z.array(z.object({ date: z.string(), index: z.number() })),
    reason: PerformanceUnavailableSchema.nullable(),
  }),
  mwr: z.object({
    kind: z.enum(['annual', 'period']),
    pct: z.number().nullable(),
    reason: PerformanceUnavailableSchema.nullable(),
  }),
  xirrPct: z.number().nullable(),
  dietzPct: z.number().nullable(),
  averageCapitalRub: decimalString,
});
export type PeriodPerformanceDto = z.infer<typeof PeriodPerformanceSchema>;

const PerformanceRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  performance: PeriodPerformanceSchema,
});

export const PerformanceQuerySchema = z
  .object({
    /** all — весь журнал; portfolio — один счёт (есть свой кэш); system — одна система (контур позиций) */
    scope: z.enum(['all', 'portfolio', 'system']).default('all'),
    id: z.string().min(1).optional(),
    /** только для scope=system: ограничить систему одним портфелем (как фильтр дашборда) */
    portfolioId: z.string().min(1).optional(),
    from: isoDate.optional(),
    till: isoDate.optional(),
  })
  .refine((q) => q.scope === 'all' || !!q.id, { message: 'для scope=portfolio|system нужен `id`' })
  .refine((q) => !q.from || !q.till || q.from <= q.till, { message: '`from` не может быть позже `till`' });
export type PerformanceQuery = z.infer<typeof PerformanceQuerySchema>;

export const PerformanceSchema = z.object({
  scope: z.enum(['all', 'portfolio', 'system']),
  id: z.string().nullable(),
  from: z.string().nullable(),
  till: z.string(),
  total: PeriodPerformanceSchema,
  bySystem: z.array(PerformanceRowSchema),
  byPortfolio: z.array(PerformanceRowSchema),
  /** инструменты, оценённые не по цене дня на конец периода (перенос цены / нет цены) */
  carried: z.array(z.object({ instrumentId: z.string(), reason: z.enum(['no-price', 'no-fx', 'carried']), priceDate: z.string().nullable() })),
});
export type PerformanceDto = z.infer<typeof PerformanceSchema>;
