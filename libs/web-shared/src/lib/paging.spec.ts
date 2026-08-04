import { describe, it, expect } from 'vitest';
import { clampPageIndex, lastPageIndex, pageSlice } from './paging';

const rows = Array.from({ length: 55 }, (_, i) => i);

describe('lastPageIndex', () => {
  it('считает последнюю страницу, неполный остаток тоже страница', () => {
    expect(lastPageIndex(55, 25)).toBe(2); // 25 + 25 + 5
    expect(lastPageIndex(50, 25)).toBe(1); // ровно две полные
  });

  it('пустой список — страница 0, а не −1', () => {
    expect(lastPageIndex(0, 25)).toBe(0);
  });

  it('строк меньше размера страницы — всё ещё одна страница', () => {
    expect(lastPageIndex(3, 25)).toBe(0);
  });
});

describe('clampPageIndex', () => {
  it('индекс в допустимых границах не трогается', () => {
    expect(clampPageIndex(1, 55, 25)).toBe(1);
  });

  it('после сужения списка индекс подрезается до последней страницы', () => {
    // Регрессия: пользователь на 3-й странице закрытых сделок выбирает портфель,
    // где их всего 10 — MatPaginator сам pageIndex не сбрасывает, и таблица
    // оставалась пустой, хотя строки есть
    expect(clampPageIndex(2, 10, 25)).toBe(0);
  });

  it('список опустел полностью — страница 0', () => {
    expect(clampPageIndex(7, 0, 25)).toBe(0);
  });

  it('отрицательный индекс не пролезает', () => {
    expect(clampPageIndex(-3, 55, 25)).toBe(0);
  });
});

describe('pageSlice', () => {
  it('режет по страницам, последняя может быть неполной', () => {
    expect(pageSlice(rows, 0, 25)).toHaveLength(25);
    expect(pageSlice(rows, 0, 25)[0]).toBe(0);
    expect(pageSlice(rows, 1, 25)[0]).toBe(25);
    expect(pageSlice(rows, 2, 25)).toHaveLength(5);
  });

  it('индекс за пределами не даёт пустой срез — отдаёт последнюю страницу', () => {
    expect(pageSlice(rows, 99, 25)).toEqual([50, 51, 52, 53, 54]);
  });

  it('пустой список — пустой срез, без падения', () => {
    expect(pageSlice([], 0, 25)).toEqual([]);
  });

  it('нулевой размер страницы отдаёт всё, а не делит на ноль', () => {
    expect(pageSlice(rows, 0, 0)).toHaveLength(55);
  });
});
