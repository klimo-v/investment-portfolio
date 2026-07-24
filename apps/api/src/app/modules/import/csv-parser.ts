import type { RawRow } from '@core';

/**
 * Парсер универсального CSV в RawRow[] (Adapter, OCP: новый брокер = новый парсер).
 * Колонки сопоставляются по заголовку (рус/англ синонимы), порядок не важен.
 */

/** Строковые поля RawRow, которые может задать колонка CSV (accountKind — не строка, из CSV не приходит) */
type CsvField = Exclude<keyof RawRow, 'accountKind'>;

/** Синонимы заголовков → канонический ключ RawRow */
const HEADER_MAP: Record<string, CsvField> = {
  дата: 'date',
  date: 'date',
  система: 'system',
  system: 'system',
  'тип инструмента': 'instrumentType',
  тикер: 'ticker',
  ticker: 'ticker',
  символ: 'ticker',
  валюта: 'currency',
  currency: 'currency',
  брокер: 'broker',
  broker: 'broker',
  'тип сделки': 'tradeType',
  'тип операции': 'tradeType',
  тип: 'tradeType',
  type: 'tradeType',
  'между портфелями': 'betweenPortfolios',
  количество: 'quantity',
  quantity: 'quantity',
  qty: 'quantity',
  цена: 'price',
  price: 'price',
  сумма: 'price',
  комиссия: 'fee',
  fee: 'fee',
  плечо: 'leverage',
  'курс к rub': 'fxRate',
  'курс': 'fxRate',
  fxrate: 'fxRate',
  примечание: 'note',
  note: 'note',
  комментарий: 'note',
};

/** Разбивает строку CSV на ячейки, учитывая кавычки */
function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** Определяет разделитель по первой строке (запятая, точка с запятой или таб) */
function detectDelimiter(headerLine: string): string {
  const counts = {
    ',': (headerLine.match(/,/g) ?? []).length,
    ';': (headerLine.match(/;/g) ?? []).length,
    '\t': (headerLine.match(/\t/g) ?? []).length,
  };
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] as string) || ',';
}

export function parseCsv(content: string): RawRow[] {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const delimiter = detectDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delimiter).map((h) => h.toLowerCase());
  const keys = headers.map((h) => HEADER_MAP[h] ?? null);

  const rows: RawRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delimiter);
    const row: RawRow = { date: '' };
    keys.forEach((key, idx) => {
      if (key && cells[idx] !== undefined) {
        row[key] = cells[idx];
      }
    });
    if (row.date) rows.push(row);
  }
  return rows;
}
