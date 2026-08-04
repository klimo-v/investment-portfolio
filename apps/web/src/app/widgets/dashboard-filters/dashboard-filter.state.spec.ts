import { describe, it, expect } from 'vitest';
import {
  formatRangeLabel,
  parseIsoDate,
  periodToRange,
  toIsoDate,
} from './dashboard-filter.state';

/**
 * Границы периода — самая незаметно ломкая часть фильтра: ошибка здесь не падает,
 * а тихо считает XIRR и реализованный P&L не за тот отрезок.
 *
 * `today` в periodToRange — аргумент, а не new Date() внутри: только поэтому тест
 * может зафиксировать дату и не зависеть от того, когда его запустили.
 */
describe('periodToRange', () => {
  // 15 июля 2026, полдень локального времени — намеренно не полночь: полночь
  // маскирует ошибки конвертации через UTC (см. toIsoDate)
  const today = new Date(2026, 6, 15, 12, 0, 0);

  it('«всё время» не ставит границ', () => {
    expect(periodToRange('all', today, null, null)).toEqual({});
  });

  it('YTD считает от 1 января текущего года до сегодня', () => {
    expect(periodToRange('ytd', today, null, null)).toEqual({
      from: '2026-01-01',
      till: '2026-07-15',
    });
  });

  it('«1 год» отсчитывает ровно год назад от сегодня', () => {
    expect(periodToRange('1y', today, null, null)).toEqual({
      from: '2025-07-15',
      till: '2026-07-15',
    });
  });

  it('произвольный диапазон берёт обе выбранные границы', () => {
    const from = new Date(2026, 2, 1);
    const till = new Date(2026, 3, 30);
    expect(periodToRange('custom', today, from, till)).toEqual({
      from: '2026-03-01',
      till: '2026-04-30',
    });
  });

  it('произвольный без одной из границ ведёт себя как «всё время»', () => {
    // Резать журнал по одной случайно введённой дате хуже, чем не резать вовсе
    expect(periodToRange('custom', today, new Date(2026, 2, 1), null)).toEqual({});
    expect(periodToRange('custom', today, null, new Date(2026, 3, 30))).toEqual({});
  });

  it('не съезжает через границу года: YTD в первый день января', () => {
    const newYear = new Date(2026, 0, 1, 3, 0, 0);
    expect(periodToRange('ytd', newYear, null, null)).toEqual({
      from: '2026-01-01',
      till: '2026-01-01',
    });
  });
});

describe('toIsoDate / parseIsoDate', () => {
  it('пишет дату по локальным компонентам, а не через UTC', () => {
    // Локальная полночь 1 июля: toISOString() на положительных смещениях отдал бы
    // «2026-06-30», и фильтр молча уехал бы на день назад
    expect(toIsoDate(new Date(2026, 6, 1, 0, 0, 0))).toBe('2026-07-01');
  });

  it('читает дату обратно в ту же календарную дату', () => {
    const parsed = parseIsoDate('2026-07-01');
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(6);
    expect(parsed?.getDate()).toBe(1);
  });

  it('мусор в параметре даёт null, а не Invalid Date', () => {
    // Пользователь может поправить адрес руками — страница от этого падать не должна
    expect(parseIsoDate(null)).toBeNull();
    expect(parseIsoDate('вчера')).toBeNull();
    expect(parseIsoDate('2026-7-1')).toBeNull();
  });
});

describe('formatRangeLabel', () => {
  it('показывает диапазон в привычном порядке день-месяц-год', () => {
    expect(formatRangeLabel({ from: '2026-01-01', till: '2026-07-29' })).toBe(
      '01.01.2026 – 29.07.2026',
    );
  });

  it('без обеих границ подписи нет — период «всё время» диапазоном не описывается', () => {
    expect(formatRangeLabel({})).toBeNull();
    expect(formatRangeLabel({ from: '2026-01-01' })).toBeNull();
  });
});
