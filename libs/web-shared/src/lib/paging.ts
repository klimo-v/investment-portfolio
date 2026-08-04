/**
 * Клиентская пагинация списков. Чистые функции — вся арифметика страниц в одном
 * месте и под тестом.
 *
 * Своя, а не MatTableDataSource: страницы здесь живут в сигналах (zoneless,
 * CLAUDE.md §4), а MatTableDataSource — императивный объект с ручной привязкой
 * paginator/sort через ViewChild, который пришлось бы синхронизировать эффектами.
 */

/**
 * Последний доступный индекс страницы (0-based). Пустой список — всё равно
 * страница 0: paginator не умеет показывать «страницу −1».
 */
export function lastPageIndex(total: number, pageSize: number): number {
  if (pageSize <= 0) return 0;
  return Math.max(0, Math.ceil(total / pageSize) - 1);
}

/**
 * Подрезает индекс страницы под фактическое количество строк.
 *
 * MatPaginator сам этого НЕ делает: если length уменьшился (сработал фильтр, строки
 * удалили), pageIndex остаётся прежним и таблица показывает пустоту, хотя данные
 * есть на первых страницах.
 */
export function clampPageIndex(pageIndex: number, total: number, pageSize: number): number {
  const last = lastPageIndex(total, pageSize);
  if (pageIndex < 0) return 0;
  return pageIndex > last ? last : pageIndex;
}

/**
 * Строки текущей страницы. Индекс подрезается тут же — иначе вызывающий код,
 * забывший про clampPageIndex, получил бы пустой срез вместо последней страницы.
 */
export function pageSlice<T>(rows: readonly T[], pageIndex: number, pageSize: number): T[] {
  if (pageSize <= 0) return [...rows];
  const start = clampPageIndex(pageIndex, rows.length, pageSize) * pageSize;
  return rows.slice(start, start + pageSize);
}
