import { z } from 'zod';

/**
 * Журнал слияний инструментов: форма JSON-снимка (`instrument_history.payload`). Снимок
 * версионируется — старые записи читаются своей версией, а не «как получится». Он пишется в той
 * же транзакции, что и слияние, и содержит всё, что слияние меняет или теряет, чтобы разделение
 * (откат) могло вернуть данные точно.
 */

/** Строка таблицы как есть (колонки БД в camelCase): значения — строки, числа или null */
const Row = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
export type SnapshotRow = z.infer<typeof Row>;

export const InstrumentRowSnapshot = z.object({
  id: z.string(),
  ticker: z.string(),
  type: z.string(),
  currency: z.string(),
  isin: z.string().nullable(),
  name: z.string().nullable(),
  marketSource: z.string(),
});

const IdentifierSnapshot = z.object({
  scheme: z.string(),
  value: z.string(),
  origin: z.string(),
  createdAt: z.string(),
});

export const MergePayloadV1 = z.object({
  version: z.literal(1),
  /** строка источника целиком */
  source: InstrumentRowSnapshot,
  /** поля цели, дописанные из источника (значения после слияния) */
  targetFilled: z.object({ isin: z.string().optional(), name: z.string().optional() }),
  /** котировка источника (null — не было) */
  sourceQuote: Row.nullable(),
  /** id перенесённых операций */
  movedOperationIds: z.array(z.string()),
  /** все строки цен источника (до слияния) */
  sourcePrices: z.array(Row),
  /** переносились ли цены (в разных валютах — отбрасываются) */
  pricesTransferred: z.boolean(),
  /** строки цели, перезаписанные ценой источника: значение до и после */
  targetPricesOverwritten: z.array(z.object({ before: Row, after: Row })),
  /** строки цели, добавленные слиянием (значение после) */
  targetPricesInserted: z.array(Row),
  /** вариационная маржа: перенесённые строки (instrumentId — источник) и потерянные при конфликте */
  settlementsMoved: z.array(Row),
  settlementsLost: z.array(Row),
  /** коды источника с исходными origin и created_at */
  sourceIdentifiers: z.array(IdentifierSnapshot),
  /** коды, добавленные самим слиянием (их не было в таблице) */
  addedIdentifiers: z.array(z.object({ scheme: z.string(), value: z.string() })),
});
export type MergePayload = z.infer<typeof MergePayloadV1>;

/** Разбор снимка по версии; неизвестная версия — ошибка, а не молчаливая догадка */
export function parseMergePayload(json: string): MergePayload {
  return MergePayloadV1.parse(JSON.parse(json));
}
