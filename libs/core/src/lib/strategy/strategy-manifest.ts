import { z } from 'zod';

/**
 * Манифест стратегии: что нужно знать о торговой системе, чтобы читать её источник данных.
 * Хранится в `strategy_configs` (adapter + params как JSON); код, который читает источник,
 * выбирается по `adapter`. Новая стратегия на том же источнике — новая строка конфига, а не
 * копия кода (OCP, CLAUDE.md §7).
 */

/** Известные адаптеры источников. Сейчас единственный — мост QUIK + журнал автомата */
export const STRATEGY_ADAPTER_IDS = ['quik-bridge'] as const;
export type StrategyAdapterId = (typeof STRATEGY_ADAPTER_IDS)[number];

export const StrategyAdapterIdSchema = z.enum(STRATEGY_ADAPTER_IDS);

/**
 * Параметры адаптера `quik-bridge`.
 *
 * `journalPrefix` — префикс файлов журнала автомата в каталоге моста:
 * `<prefix>_trades.csv`, `<prefix>_trades_before_*.csv`, `<prefix>_fills.csv`,
 * `<prefix>_daily.csv`, `<prefix>_signals*.csv`, `<prefix>_log_ГГГГ-ММ-ДД.txt`.
 * Он же задаёт правило принадлежности сделки: сделка счёта относится к стратегии,
 * если её номер есть в журнале этой стратегии.
 */
export const QuikBridgeParamsSchema = z.object({
  journalPrefix: z
    .string()
    .regex(/^[a-z][a-z0-9]*$/, 'Префикс журнала — латиница в нижнем регистре и цифры')
    .default('yv1'),
});
export type QuikBridgeParams = z.infer<typeof QuikBridgeParamsSchema>;

/** Разобрать `params` из БД; пустой объект — значения по умолчанию */
export function parseQuikBridgeParams(json: string): QuikBridgeParams {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Параметры стратегии — не JSON');
  }
  return QuikBridgeParamsSchema.parse(raw);
}

/** Строка списка стратегий: что показать в меню и к какому портфелю привязана */
export const StrategySummarySchema = z.object({
  systemId: z.string(),
  name: z.string(),
  adapter: StrategyAdapterIdSchema,
  portfolioId: z.string().nullable(),
  portfolioName: z.string().nullable(),
});
export type StrategySummary = z.infer<typeof StrategySummarySchema>;
