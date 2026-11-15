/**
 * Преобразования календарной даты ↔ `YYYY-MM-DD` (FSD: shared — ни от чего не зависит).
 * Используются везде, где дата из Material-пикера уходит на бэк или в адресную
 * строку: фильтры дашборда и период синхронизации с брокером.
 */

/**
 * Дата пикера → YYYY-MM-DD по ЛОКАЛЬНЫМ компонентам, не через toISOString():
 * тот конвертирует через UTC и на выбранной пользователем календарной дате
 * (локальная полночь) может откатить день назад в зависимости от часового пояса —
 * пользователь выбрал 1 июля, а фильтр получил бы 30 июня.
 */
export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * YYYY-MM-DD из адресной строки → Date в ЛОКАЛЬНОЙ полуночи (симметрично
 * toIsoDate). `new Date('2026-07-01')` дал бы UTC-полночь, то есть на минусовых
 * смещениях — 30 июня в пикере. Мусор в параметре даёт null, а не Invalid Date.
 */
export function parseIsoDate(raw: string | null): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) || toIsoDate(date) !== raw ? null : date;
}
