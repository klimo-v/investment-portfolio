/**
 * Клиентская сортировка таблиц. Чистые функции — как и paging.ts, вся неочевидная
 * часть вынесена из компонентов страниц туда, где её можно протестировать
 * (у `apps/web` нет test-таргета).
 *
 * Неочевидного тут ровно два места: «пусто всегда внизу» и составной ключ.
 */

/** Направление; пустая строка — состояние «не отсортировано» у MatSortHeader */
export type SortDirection = 'asc' | 'desc' | '';

/** Структурно совместимо с `Sort` из @angular/material/sort, но без зависимости от него */
export interface SortState {
  active: string;
  direction: SortDirection;
}

/** Значение колонки для сравнения. null — метрика не определена («—» в ячейке) */
export type SortValue = string | number | null;

/**
 * Составной ключ: элементы сравниваются по очереди, первый ненулевой результат
 * побеждает. Нужен там, где ячейка показывает ДВА значения («Открыта / Закрыта»,
 * «остаток / куплено») — сортируем по первому, при равенстве уточняем вторым.
 */
export type SortKey = SortValue | readonly SortValue[];

/**
 * Сравнение двух значений одной колонки.
 *
 * null («—») уезжает вниз при ЛЮБОМ направлении, а не считается «меньше всех»:
 * иначе сортировка по XIRR/P&L вверх начиналась бы с прочерков вместо худших
 * чисел, и первый экран не нёс бы информации.
 *
 * Строки сравниваем через localeCompare с русской локалью — иначе «Я» < «а»
 * по кодам UTF-16, и кириллица сортируется через букву.
 */
export function compareSortValues(a: SortValue, b: SortValue, direction: SortDirection): number {
  if (!direction) return 0;
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  const sign = direction === 'asc' ? 1 : -1;
  if (typeof a === 'string' || typeof b === 'string') {
    return sign * String(a).localeCompare(String(b), 'ru');
  }
  return sign * (a - b);
}

/**
 * Копия `rows`, отсортированная по текущему состоянию сортировки. Пустое
 * `direction` (третий клик по заголовку у Material) возвращает исходный порядок —
 * поэтому сортируем копию, а не на месте.
 *
 * `value` достаёт ключ колонки: страница знает про свои данные, хелпер — про
 * порядок сравнения (разделение как у mat-table: данные снаружи, механика внутри).
 */
export function sortRows<T>(
  rows: readonly T[],
  sort: SortState,
  value: (row: T, column: string) => SortKey,
): T[] {
  if (!sort.active || !sort.direction) return [...rows];

  const keyOf = (row: T): readonly SortValue[] => {
    const key = value(row, sort.active);
    return Array.isArray(key) ? key : [key as SortValue];
  };

  return [...rows].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    const depth = Math.max(ka.length, kb.length);
    for (let i = 0; i < depth; i++) {
      const result = compareSortValues(ka[i] ?? null, kb[i] ?? null, sort.direction);
      if (result !== 0) return result;
    }
    return 0;
  });
}
