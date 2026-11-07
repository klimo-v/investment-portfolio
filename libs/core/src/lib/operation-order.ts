import type { Operation } from './schemas';

/**
 * Единый порядок операций для всех расчётов движка: дата → время сделки → номер у брокера.
 *
 * Время нужно, потому что результат по шортам (фьючерсы) зависит от порядка внутри дня:
 * продажи 05.11 раньше покупок дают другой итог, чем после них. У операций без времени
 * (всё, что было до появления `executedAt`) ключ времени пустой, а номер брокера в
 * сравнении не участвует — их относительный порядок остаётся прежним (сортировка
 * устойчива), то есть расчёты по старым данным не меняются.
 */
function orderKey(op: Operation): [string, string, string] {
  const time = op.executedAt ?? '';
  return [op.date, time, time ? (op.brokerRef ?? '') : ''];
}

/** Сравнение номеров: сначала по длине, затем лексикографически (числовой порядок строк) */
function compareRefs(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

export function compareOperations(a: Operation, b: Operation): number {
  const [da, ta, ra] = orderKey(a);
  const [db, tb, rb] = orderKey(b);
  return da.localeCompare(db) || ta.localeCompare(tb) || compareRefs(ra, rb);
}
