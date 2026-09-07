import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  portfolioSnapshots,
  snapshotInvalidations,
  snapshotPositions,
  type SnapshotInvalidationRow,
} from './schema';

/** Вид ретро-изменения журнала — берём прямо из enum-колонки, чтобы не разъехались */
export type SnapshotInvalidationKind = SnapshotInvalidationRow['kind'];

export interface SnapshotInvalidationEntry {
  kind: SnapshotInvalidationKind;
  /** дата затронутой операции (YYYY-MM-DD) */
  operationDate: string;
  /** описание САМОЙ операции для таблицы в модалке: «Sell 10 SBER» (что с ней сделали — в kind) */
  description: string;
  ticker?: string | null;
  /** сколько операций затронуто (батчи импорта/слияния) */
  affectedCount?: number;
}

/**
 * Помечает уже снятые снимки как недостоверные — вместо того, чтобы их стирать.
 *
 * Снимок кумулятивен: на дату захвата S он суммирует ВЕСЬ журнал операций, какой бы
 * датой сами операции ни были помечены. Поэтому правка операции с датой D делает
 * недостоверным ровно те снимки, у которых date >= D, а пересчитать их не из чего —
 * дневных цен по каждой бумаге в системе нет, есть только текущая котировка.
 *
 * Раньше на это отвечали стиранием всей истории: один-единственный кейс («дашборд
 * показал −83.68% просадки», сравнив снимок до полной замены журнала со снимком
 * после) стоил месяцев накопленных точек графика. Теперь история сохраняется, а сюда
 * пишется строка «что именно изменилось» — дашборд показывает иконку-предупреждение
 * с датой, НАЧИНАЯ с которой цифрам доверять нельзя, и таблицей изменений.
 *
 * Ничего не пишем, если портить нечего: снимков нет вообще, либо самый свежий снят
 * РАНЬШЕ даты операции (такой снимок этой операции никогда и не видел — типичный
 * случай обычного добавления операции сегодняшним числом).
 */
export function recordSnapshotInvalidation(
  db: BetterSQLite3Database,
  entry: SnapshotInvalidationEntry,
): void {
  const [latest] = db
    .select({ maxDate: sql<string | null>`max(${portfolioSnapshots.date})` })
    .from(portfolioSnapshots)
    .all();

  const maxDate = latest?.maxDate ?? null;
  if (maxDate === null || maxDate < entry.operationDate) return;

  db.insert(snapshotInvalidations)
    .values({
      id: randomUUID(),
      kind: entry.kind,
      operationDate: entry.operationDate,
      description: entry.description,
      ticker: entry.ticker ?? null,
      affectedCount: entry.affectedCount ?? 1,
    })
    .run();
}

/**
 * Стирает накопленную историю снимков вместе с журналом изменений.
 *
 * Единственный вызов — DELETE /api/snapshots, то есть осознанное «Очистить историю
 * снимков» из модалки. Автоматически это больше не делает никто: сохранённая
 * история с честной пометкой «этим цифрам доверять нельзя» полезнее пустого графика.
 */
export function clearSnapshotHistory(db: BetterSQLite3Database): void {
  db.delete(snapshotPositions).run();
  db.delete(portfolioSnapshots).run();
  db.delete(snapshotInvalidations).run();
}
