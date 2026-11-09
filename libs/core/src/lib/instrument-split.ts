import Decimal from 'decimal.js';
import { z } from 'zod';
import { TradeLedger, calculatePositions } from './engine';
import { normalizeCode, normalizeName } from './instrument-identity';
import { compareOperations } from './operation-order';
import { InstrumentType, type Operation } from './schemas';

/**
 * Разделение инструмента: часть операций и кодов переезжает в НОВЫЙ инструмент. Это единственная
 * операция записи для «выделить заново» и для отката слияния: откат — то же разделение, план
 * которого заполнен по журналу. Здесь — чистое планирование без БД: проверки и предпросмотр.
 */

Decimal.set({ precision: 40 });

/** Новый инструмент */
export const NewInstrumentSchema = z.object({
  id: z.string().min(1),
  ticker: z.string().min(1),
  type: InstrumentType,
  currency: z.string().min(1),
  name: z.string().nullish(),
  isin: z.string().nullish(),
  marketSource: z.enum(['moex', 'cbr', 'binance', 'manual']).default('manual'),
});
export type NewInstrument = z.infer<typeof NewInstrumentSchema>;

/** Тело запроса на разделение / его предпросмотр */
export const SplitRequestSchema = z.object({
  newInstrument: NewInstrumentSchema,
  /** операции, которые уходят в новый инструмент */
  operationIds: z.array(z.string()),
  /** коды (`scheme:value`), которые уходят в новый инструмент */
  identifierKeys: z.array(z.string()).default([]),
  /** поправки полей остающегося инструмента (например, name, затёртый слиянием) */
  fieldPatches: z.object({ name: z.string().nullish(), isin: z.string().nullish() }).optional(),
  /** подтверждение предупреждения «появится продажа без позиции» */
  confirmOrphanSells: z.boolean().default(false),
  /** слияние из журнала, которое откатывает это разделение (шаг отката) */
  undoesMergeId: z.string().optional(),
});
export type SplitRequest = z.infer<typeof SplitRequestSchema>;

export interface SplitIdentifier {
  scheme: string;
  value: string;
  origin: string;
  createdAt: string;
}

export interface SplitInput {
  instrumentId: string;
  /** все операции исходного инструмента */
  operations: readonly Operation[];
  /** все коды исходного инструмента */
  identifiers: readonly SplitIdentifier[];
  /** id всех существующих инструментов — проверка занятости id */
  takenInstrumentIds: ReadonlySet<string>;
  /** коды (scheme:value) всех инструментов — чтобы не дублировать код нового инструмента */
  takenIdentifierKeys: ReadonlySet<string>;
  request: SplitRequest;
  futureIds?: ReadonlySet<string>;
  /** откат слияния источника без операций допустим: пустой выбор операций — не ошибка */
  allowEmptyOperations?: boolean;
}

export interface SplitPositionPreview {
  systemId: string;
  portfolioId: string;
  quantity: string;
  avgBuyPrice: string;
}

export interface SplitSidePreview {
  operations: number;
  positions: SplitPositionPreview[];
  /** продажи без позиции (в журнале этой стороны) */
  orphanSells: number;
}

export interface SplitPlan {
  /** непустые errors — разделение невозможно */
  errors: string[];
  /** требуют подтверждения (confirmOrphanSells) */
  warnings: string[];
  /** появится продажа без позиции — нужно confirmOrphanSells */
  orphanSellsAppear: boolean;
  movedOperationIds: string[];
  movedIdentifiers: SplitIdentifier[];
  /** коды, которые получает новый инструмент сверх перенесённых (тикер, название) */
  addedIdentifiers: { scheme: 'ticker' | 'name'; value: string }[];
  /** кто получит коды: оставшиеся у исходного */
  remainingIdentifiers: SplitIdentifier[];
  /** до разделения / после: остающийся и новый */
  preview: { before: SplitSidePreview; remaining: SplitSidePreview; created: SplitSidePreview };
}

const idKey = (e: { scheme: string; value: string }): string => `${e.scheme}:${e.value}`;

function sidePreview(ops: readonly Operation[], futureIds?: ReadonlySet<string>): SplitSidePreview {
  const ledger = new TradeLedger({ futureIds });
  for (const op of [...ops].sort(compareOperations)) ledger.apply(op);
  return {
    operations: ops.length,
    positions: calculatePositions([...ops], { futureIds })
      .filter((p) => !p.quantity.isZero())
      .map((p) => ({
        systemId: p.systemId,
        portfolioId: p.portfolioId,
        quantity: p.quantity.toFixed(),
        avgBuyPrice: p.avgBuyPrice.toFixed(8),
      })),
    orphanSells: ledger.orphanSells.length,
  };
}

export function planInstrumentSplit(input: SplitInput): SplitPlan {
  const { request: req } = input;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (input.takenInstrumentIds.has(req.newInstrument.id)) errors.push(`Идентификатор уже занят: ${req.newInstrument.id}.`);
  if (req.operationIds.length === 0 && !input.allowEmptyOperations) errors.push('Не выбрано ни одной операции для нового инструмента.');

  const byId = new Map(input.operations.map((o) => [o.id, o]));
  const wanted = new Set(req.operationIds);
  const foreign = req.operationIds.filter((id) => !byId.has(id));
  if (foreign.length > 0) errors.push(`Операции не принадлежат этому инструменту: ${foreign.join(', ')}.`);

  const identifiers = new Map(input.identifiers.map((e) => [idKey(e), e]));
  const unknownCodes = req.identifierKeys.filter((k) => !identifiers.has(k));
  if (unknownCodes.length > 0) errors.push(`Коды не принадлежат этому инструменту: ${unknownCodes.join(', ')}.`);
  const movedKeys = new Set(req.identifierKeys);

  const movedOps = input.operations.filter((o) => o.id && wanted.has(o.id));
  const remainingOps = input.operations.filter((o) => !(o.id && wanted.has(o.id)));
  const movedIdentifiers = input.identifiers.filter((e) => movedKeys.has(idKey(e)));
  const remainingIdentifiers = input.identifiers.filter((e) => !movedKeys.has(idKey(e)));

  // собственные коды нового инструмента: тикер и название, если их ещё никто не держит
  const addedIdentifiers: SplitPlan['addedIdentifiers'] = [];
  const taken = new Set(input.takenIdentifierKeys);
  const t = normalizeCode(req.newInstrument.ticker);
  const n = normalizeName(req.newInstrument.name);
  const own = [
    ...(t ? [{ scheme: 'ticker' as const, value: t }] : []),
    ...(n ? [{ scheme: 'name' as const, value: n }] : []),
  ];
  for (const e of own) {
    if (movedKeys.has(idKey(e))) continue;
    if (taken.has(idKey(e))) {
      warnings.push(`Код ${idKey(e)} остаётся у исходного инструмента — повторный импорт по нему не попадёт в новый.`);
      continue;
    }
    addedIdentifiers.push(e);
  }

  const before = sidePreview(input.operations, input.futureIds);
  const remaining = sidePreview(remainingOps, input.futureIds);
  const created = sidePreview(movedOps, input.futureIds);
  const orphanSellsAppear = remaining.orphanSells > before.orphanSells || created.orphanSells > before.orphanSells;
  if (orphanSellsAppear) {
    warnings.push(
      `После разделения появятся продажи без позиции: у остающегося ${remaining.orphanSells}, у нового ${created.orphanSells} (было ${before.orphanSells}).`,
    );
  }

  return {
    errors,
    warnings,
    orphanSellsAppear,
    movedOperationIds: movedOps.map((o) => o.id as string),
    movedIdentifiers,
    addedIdentifiers,
    remainingIdentifiers,
    preview: { before, remaining, created },
  };
}
