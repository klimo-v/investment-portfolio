import { describe, it, expect } from 'vitest';
import { compareSortValues, sortRows, type SortKey } from './sorting';

interface Row {
  name: string;
  pnl: number | null;
  openedAt: string;
  closedAt: string | null;
}

const rows: Row[] = [
  { name: 'SBER', pnl: 9214, openedAt: '2025-02-27', closedAt: '2025-03-14' },
  { name: 'GAZP', pnl: -1200, openedAt: '2025-02-27', closedAt: '2025-05-01' },
  { name: 'ЛУКОЙЛ', pnl: null, openedAt: '2025-01-10', closedAt: null },
  { name: 'aFLT', pnl: 340, openedAt: '2025-06-02', closedAt: null },
];

const value = (row: Row, column: string): SortKey => {
  switch (column) {
    case 'name':
      return row.name;
    case 'pnl':
      return row.pnl;
    case 'dates':
      return [row.openedAt, row.closedAt];
    default:
      return null;
  }
};

const names = (list: Row[]): string[] => list.map((r) => r.name);

describe('compareSortValues', () => {
  it('числа сравниваются численно, строки — лексикографически', () => {
    expect(compareSortValues(1, 2, 'asc')).toBeLessThan(0);
    expect(compareSortValues(1, 2, 'desc')).toBeGreaterThan(0);
    expect(compareSortValues('a', 'b', 'asc')).toBeLessThan(0);
  });

  it('пустое направление — порядок не меняем', () => {
    expect(compareSortValues(1, 2, '')).toBe(0);
    expect(compareSortValues(null, 5, '')).toBe(0);
  });

  it('null уезжает вниз при ЛЮБОМ направлении', () => {
    expect(compareSortValues(null, 5, 'asc')).toBeGreaterThan(0);
    expect(compareSortValues(null, 5, 'desc')).toBeGreaterThan(0);
    expect(compareSortValues(5, null, 'desc')).toBeLessThan(0);
    expect(compareSortValues(null, null, 'asc')).toBe(0);
  });

  it('кириллица сортируется по алфавиту, а не по кодам символов', () => {
    // По UTF-16 'Я' (0x042F) < 'а' (0x0430) — без локали «Яндекс» встал бы перед «авто»
    expect(compareSortValues('авто', 'Яндекс', 'asc')).toBeLessThan(0);
  });
});

describe('sortRows', () => {
  it('сортирует по числовой колонке, не мутируя исходный массив', () => {
    const source = [...rows];
    const sorted = sortRows(source, { active: 'pnl', direction: 'desc' }, value);
    expect(names(sorted)).toEqual(['SBER', 'aFLT', 'GAZP', 'ЛУКОЙЛ']);
    expect(names(source)).toEqual(names(rows)); // исходный порядок цел
  });

  it('строки с «—» стоят последними и при возрастании тоже', () => {
    const sorted = sortRows(rows, { active: 'pnl', direction: 'asc' }, value);
    expect(names(sorted)).toEqual(['GAZP', 'aFLT', 'SBER', 'ЛУКОЙЛ']);
  });

  it('пустое direction возвращает исходный порядок', () => {
    expect(names(sortRows(rows, { active: 'pnl', direction: '' }, value))).toEqual(names(rows));
  });

  it('пустая колонка возвращает исходный порядок', () => {
    expect(names(sortRows(rows, { active: '', direction: 'asc' }, value))).toEqual(names(rows));
  });

  it('составной ключ: при равной первой дате решает вторая', () => {
    // SBER и GAZP открыты в один день — порядок задаёт дата закрытия
    const sorted = sortRows(rows, { active: 'dates', direction: 'asc' }, value);
    expect(names(sorted)).toEqual(['ЛУКОЙЛ', 'SBER', 'GAZP', 'aFLT']);
  });

  it('составной ключ: null во второй позиции тоже уезжает вниз внутри своей группы', () => {
    const same: Row[] = [
      { name: 'открыта', pnl: 0, openedAt: '2025-02-27', closedAt: null },
      { name: 'закрыта', pnl: 0, openedAt: '2025-02-27', closedAt: '2025-03-14' },
    ];
    expect(names(sortRows(same, { active: 'dates', direction: 'asc' }, value))).toEqual([
      'закрыта',
      'открыта',
    ]);
  });

  it('неизвестная колонка не роняет и не переставляет', () => {
    expect(names(sortRows(rows, { active: 'нет-такой', direction: 'asc' }, value))).toEqual(
      names(rows),
    );
  });

  it('пустой список сортируется в пустой', () => {
    expect(sortRows([], { active: 'pnl', direction: 'asc' }, value)).toEqual([]);
  });
});
