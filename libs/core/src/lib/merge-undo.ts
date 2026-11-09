import { z } from 'zod';
import type { MergePayload } from './instrument-history';

/**
 * План отката слияния: распределение операций и кодов между источником (восстанавливается) и целью.
 * Откат — это разделение (`planInstrumentSplit`), план которого заполнен по журналу. Здесь —
 * чистая классификация без БД; восстановление цен, котировки и т. п. делает сервис по снимку.
 *
 * Принцип: ничего не угадываем. Операция относится к источнику, если её id есть в снимке или её
 * `source_code` входит в коды источника из снимка; к цели — если `source_code` входит в коды цели.
 * Операции без кода или с новым кодом — «неясные»: пока пользователь не распределил их явно,
 * откат отклоняется.
 */

export interface UndoOperation {
  id: string;
  date: string;
  operationType: string;
  quantity: string;
  price: string;
  sourceCode?: string | null;
}

export interface UndoCode {
  scheme: string;
  value: string;
  origin: string;
  createdAt: string;
}

export interface MergeUndoInput {
  event: { id: string; at: string; sourceId: string; targetId: string; undone: boolean; payload: MergePayload };
  /** более поздние неотменённые слияния, затрагивающие источник или цель */
  laterMerges: readonly { id: string; sourceTicker: string; targetTicker: string }[];
  /** id всех существующих инструментов */
  instrumentIds: ReadonlySet<string>;
  /** все текущие операции цели */
  targetOperations: readonly UndoOperation[];
  /** все текущие коды цели */
  targetIdentifiers: readonly UndoCode[];
  /** явное распределение неясных операций */
  assignments?: { toSource?: readonly string[]; toTarget?: readonly string[] };
}

export interface MergeUndoPlan {
  /** непустой — откат невозможен */
  errors: string[];
  /** операции, которые нельзя отнести ни к источнику, ни к цели без решения пользователя */
  unclear: UndoOperation[];
  toSource: string[];
  toTarget: string[];
  /** операции из снимка, которых у цели уже нет (удалены или переназначены) — пропускаются */
  skippedOperations: string[];
  /** коды, возвращаемые источнику (из снимка и добавленные самим слиянием) */
  identifiersToSource: { scheme: string; value: string }[];
  /** коды, добавленные после слияния, — остаются у цели (показываются в плане) */
  identifiersAfterMerge: UndoCode[];
  /** коды из снимка, которых у цели уже нет — пропускаются */
  identifiersMissing: { scheme: string; value: string }[];
}

const key = (e: { scheme: string; value: string }): string => `${e.scheme}:${e.value}`;

export function planMergeUndo(input: MergeUndoInput): MergeUndoPlan {
  const { event } = input;
  const p = event.payload;
  const errors: string[] = [];

  if (event.undone) errors.push('Это слияние уже отменено.');
  for (const m of input.laterMerges) {
    errors.push(`Сначала отмените более позднее слияние ${m.sourceTicker} → ${m.targetTicker} (${m.id}): оно затрагивает эти же инструменты.`);
  }
  if (input.instrumentIds.has(event.sourceId)) errors.push(`Идентификатор источника уже занят: ${event.sourceId}.`);
  if (!input.instrumentIds.has(event.targetId)) errors.push(`Цель слияния больше не существует: ${event.targetId}.`);

  const sourceCodes = new Set([...p.sourceIdentifiers, ...p.addedIdentifiers].map(key));
  const targetCodes = new Set(input.targetIdentifiers.filter((e) => !sourceCodes.has(key(e))).map(key));
  const snapshotOps = new Set(p.movedOperationIds);
  const present = new Set(input.targetOperations.map((o) => o.id));
  const forSource = new Set(input.assignments?.toSource ?? []);
  const forTarget = new Set(input.assignments?.toTarget ?? []);

  const toSource: string[] = [];
  const toTarget: string[] = [];
  const unclear: UndoOperation[] = [];
  for (const op of input.targetOperations) {
    if (snapshotOps.has(op.id)) toSource.push(op.id);
    else if (op.sourceCode && sourceCodes.has(op.sourceCode)) toSource.push(op.id);
    else if (op.sourceCode && targetCodes.has(op.sourceCode)) toTarget.push(op.id);
    else if (forSource.has(op.id)) toSource.push(op.id);
    else if (forTarget.has(op.id)) toTarget.push(op.id);
    else unclear.push(op);
  }
  if (unclear.length > 0) {
    errors.push(`Нужно явно распределить неясные операции (${unclear.length}): у них нет кода или код новый.`);
  }

  const heldNow = new Set(input.targetIdentifiers.map(key));
  const snapshotCodes = [...p.sourceIdentifiers, ...p.addedIdentifiers];
  return {
    errors,
    unclear,
    toSource,
    toTarget,
    skippedOperations: p.movedOperationIds.filter((id) => !present.has(id)),
    identifiersToSource: snapshotCodes.filter((e) => heldNow.has(key(e))).map(({ scheme, value }) => ({ scheme, value })),
    identifiersMissing: snapshotCodes.filter((e) => !heldNow.has(key(e))).map(({ scheme, value }) => ({ scheme, value })),
    identifiersAfterMerge: input.targetIdentifiers.filter((e) => !sourceCodes.has(key(e)) && e.createdAt > event.at),
  };
}

/** Тело запроса плана и самого отката: явное распределение неясных операций + подтверждение продаж без позиции */
export const UndoRequestSchema = z.object({
  assignments: z.object({ toSource: z.array(z.string()).optional(), toTarget: z.array(z.string()).optional() }).optional(),
  confirmOrphanSells: z.boolean().optional(),
});
export type UndoRequest = z.infer<typeof UndoRequestSchema>;
