/**
 * Выгрузка таблиц в CSV (FSD: shared — ни от чего не зависит).
 *
 * Формат подобран под Excel с русской локалью, потому что именно там файл и
 * открывают: разделитель `;` (при `,` ru-Excel кладёт всю строку в одну ячейку),
 * десятичная запятая (иначе числа приезжают текстом и по ним не построить сумму),
 * CRLF (RFC 4180) и BOM (без него кириллица в заголовках превращается в кракозябры).
 */

/** Значение ячейки. Число и строка различаются: числа форматируются, строки экранируются. */
export type CsvCell = string | number | null | undefined;

/** Колонка выгрузки: заголовок и способ достать значение из строки данных */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => CsvCell;
}

const DELIMITER = ';';
const EOL = '\r\n';

/**
 * Символы, с которых Excel/LibreOffice начинают трактовать содержимое ячейки как
 * формулу. Значения у нас пользовательские (названия систем и портфелей), поэтому
 * такую ячейку помечаем как текст — иначе открытый файл выполнит чужую формулу
 * (CSV injection, CLAUDE.md §8).
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Число → текст ячейки. Точность НЕ трогаем: вызывающий код сам решает, где
 * округлить до копеек, а где сохранить восемь знаков количества (криптовалюта).
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  return String(value).replace('.', ',');
}

function formatText(value: string): string {
  const guarded = FORMULA_PREFIXES.some((p) => value.startsWith(p)) ? `'${value}` : value;
  // кавычки, разделитель и переносы строк требуют обрамления, внутренние кавычки — удвоения
  return /["\r\n;]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** Одна ячейка в готовом для файла виде. Пустое значение — пустая ячейка, а не «null». */
export function formatCsvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'number' ? formatNumber(value) : formatText(value);
}

/** Строки данных + описание колонок → содержимое CSV-файла (без BOM) */
export function buildCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const header = columns.map((c) => formatCsvCell(c.header)).join(DELIMITER);
  const body = rows.map((row) => columns.map((c) => formatCsvCell(c.value(row))).join(DELIMITER));
  return [header, ...body].join(EOL);
}

/**
 * Отдать содержимое пользователю как файл. Единственное место с DOM-побочкой —
 * поэтому `buildCsv` остаётся чистой функцией и тестируется без браузера.
 */
export function downloadCsv(filename: string, content: string): void {
  // BOM: без него Excel читает файл в системной однобайтовой кодировке
  const blob = new Blob(['\uFEFF', content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // освобождаем ссылку следующим тиком: часть браузеров отменяет ещё не начатую
  // загрузку, если revoke произошёл в том же кадре, что и click()
  setTimeout(() => URL.revokeObjectURL(url));
}

/**
 * Кусок имени файла из произвольного текста (название системы, портфеля).
 * Буквы и цифры любого алфавита оставляем — кириллица в имени файла нормальна,
 * а вот пробелы, слэши и кавычки ломают сохранение.
 */
export function slugForFilename(value: string): string {
  return value
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}
