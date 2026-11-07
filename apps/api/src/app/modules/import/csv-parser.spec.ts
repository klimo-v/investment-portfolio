import { describe, it, expect } from 'vitest';
import { parseCsv } from './csv-parser';

describe('parseCsv — колонка ISIN', () => {
  it('необязательная колонка isin → identifiers.isin', () => {
    const rows = parseCsv('Дата,Тикер,ISIN,Тип,Количество,Цена\n2026-01-05,SBER,RU0009029540,Buy,10,300\n2026-01-06,GAZP,,Buy,1,100');
    expect(rows[0].identifiers).toEqual({ isin: 'RU0009029540' });
    expect(rows[0].ticker).toBe('SBER');
    expect(rows[1].identifiers).toBeUndefined();
  });

  it('без колонки isin поведение прежнее', () => {
    const [r] = parseCsv('date,ticker,type,qty,price\n2026-01-05,SBER,Buy,10,300');
    expect(r.identifiers).toBeUndefined();
    expect(r.ticker).toBe('SBER');
  });
});
