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
  // P&L по системам (столбцы)
  bySystem: z.array(
    z.object({
      systemId: z.string(),
      name: z.string(),
      investedRub: z.number(),
      pnlRub: z.number(),
    }),
  ),
  // breakdown прибыль/убыток по инструментам (бары)
  breakdown: z.array(
    z.object({
      ticker: z.string(),
      pnlRub: z.number(),
    }),
  ),
  totals: z.object({
    investedRub: z.number(),
    currentValueRub: z.number(),
    pnlRub: z.number(),
    dividendsRub: z.number(),
  }),
});
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;
