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

/** Портфель / брокерский счёт (справочник, docs/02-data-model.md §2.3) */
export const PortfolioSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  broker: z.string().min(1),
  baseCurrency: z.string().min(1).default('RUB'),
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
  dividendsRub: decimalString,
  couponsRub: decimalString,
  currentPrice: decimalString.nullable(),
  currentValueRub: decimalString.nullable(),
  pnlRub: decimalString.nullable(),
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
});
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

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
  currentPrice: decimalString.nullable(),
  currentValueRub: decimalString.nullable(),
  pnlRub: decimalString.nullable(), // реализованный + нереализованный + выплаты
  openedAt: z.string(),
  closedAt: z.string().nullable(),
  /** id операций, из которых собрана сделка — для раскрытия строки в UI */
  operationIds: z.array(z.string()),
});
export type Trade = z.infer<typeof TradeSchema>;

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
