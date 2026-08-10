import { describe, it, expect } from 'vitest';
import { buildCsv, formatCsvCell, slugForFilename, type CsvColumn } from './csv';

interface Row {
  ticker: string;
  qty: number;
  pnl: number | null;
}

const columns: CsvColumn<Row>[] = [
  { header: 'Тикер', value: (r) => r.ticker },
  { header: 'Кол-во', value: (r) => r.qty },
  { header: 'P&L (₽)', value: (r) => r.pnl },
];

describe('formatCsvCell', () => {
  it('числа — с десятичной запятой, точность не теряется', () => {
    expect(formatCsvCell(1234.56)).toBe('1234,56');
    expect(formatCsvCell(0.00123456)).toBe('0,00123456');
    expect(formatCsvCell(-84248.81)).toBe('-84248,81');
    expect(formatCsvCell(0)).toBe('0');
  });

  it('пустое значение — пустая ячейка, а не «null»', () => {
    expect(formatCsvCell(null)).toBe('');
    expect(formatCsvCell(undefined)).toBe('');
    expect(formatCsvCell(Number.NaN)).toBe('');
  });

  it('разделитель, кавычки и перенос строки внутри текста обрамляются', () => {
    expect(formatCsvCell('ИИС; основной')).toBe('"ИИС; основной"');
    expect(formatCsvCell('бумага "Х"')).toBe('"бумага ""Х"""');
    expect(formatCsvCell('две\nстроки')).toBe('"две\nстроки"');
  });

  it('текст, похожий на формулу, помечается как текст (CSV injection)', () => {
    expect(formatCsvCell('=1+1')).toBe("'=1+1");
    expect(formatCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    // а отрицательное ЧИСЛО остаётся числом — экранируется только строка
    expect(formatCsvCell(-5)).toBe('-5');
  });
});

describe('buildCsv', () => {
  it('заголовок и строки через `;` и CRLF', () => {
    const csv = buildCsv(
      [
        { ticker: 'SBER', qty: 100, pnl: 9214.5 },
        { ticker: 'GAZP', qty: 20, pnl: null },
      ],
      columns,
    );

    expect(csv).toBe(
      'Тикер;Кол-во;P&L (₽)\r\n' + //
        'SBER;100;9214,5\r\n' +
        'GAZP;20;',
    );
  });

  it('пустой список — только заголовок', () => {
    expect(buildCsv([], columns)).toBe('Тикер;Кол-во;P&L (₽)');
  });
});

describe('slugForFilename', () => {
  it('кириллицу сохраняет, разделители схлопывает', () => {
    expect(slugForFilename('ИИС Сбер')).toBe('ИИС-Сбер');
    expect(slugForFilename(' Long/Short  #2 ')).toBe('Long-Short-2');
  });
});
