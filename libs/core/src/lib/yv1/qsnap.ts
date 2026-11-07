/**
 * Мост QUIK (qsnap): разбор файлов `qsnap_raw.csv` / `qsnap_index.csv` и проверка
 * целостности снимков. Только чтение текста — файловой системы здесь нет, чтобы код
 * одинаково работал на бэкенде и в тестах (libs/core не знает про Node).
 *
 * Формат описан в шапке `quik_snapshot.lua`:
 *  - raw: `snap_id,table,row,field,value` — «длинный» формат, одна строка на поле;
 *  - index: по строке на запуск; индекс пишется ПОСЛЕДНИМ, поэтому снимок без строки
 *    индекса — незавершённый;
 *  - значения — текст; 19-значные trade_num/order_num читаем только строкой.
 *
 * Правило времени (документируем явно, см. docs/yv1-bridge.md): все моменты из
 * таблиц QUIK (`datetime.*`) — биржевое время, то есть МСК, и не сдвигаются.
 * `local_time` снимка — часы машины, где крутится скрипт (МСК); `server_time` — время
 * сервера QUIK без даты, ночью оно замирает и «отстаёт» на ~30 минут. Поэтому
 * `server_time` нигде не используется как момент события, а разница с local_time
 * сохраняется как диагностика (`clockSkewSec`).
 */

/** Версии формата, которые умеем читать; на любой другой падаем с понятной ошибкой */
export const SUPPORTED_SCRIPT_VERSIONS: readonly string[] = ['2', '3'];

/** Ошибка формата файлов моста — текст предназначен для пользователя */
export class QsnapFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QsnapFormatError';
  }
}

export interface QsnapRawRow {
  snapId: string;
  table: string;
  row: number;
  field: string;
  value: string;
}

export interface QsnapIndexRow {
  snapId: string;
  /** МСК, `YYYY-MM-DD HH:MM:SS` */
  localTime: string;
  /** время сервера QUIK без даты, как есть (`1:58:54`) */
  serverTime: string;
  serverTimeEnd: string;
  /** торговая дата, ISO */
  tradeDate: string;
  connected: boolean;
  quikVersion: string;
  scriptVersion: string;
  status: string;
  rawLines: number;
  rawBytes: number;
  floatIds: number;
  counts: string;
  errors: string;
}

/**
 * CSV с запятой, `\n` в конце строки, значения с запятой/кавычкой в `"` (внутри
 * кавычки удваиваются). Пустые строки пропускаются.
 */
export function parseCsvRecords(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n') {
      row.push(cur);
      out.push(row);
      row = [];
      cur = '';
    } else if (ch !== '\r') cur += ch;
  }
  if (inQuotes) throw new QsnapFormatError('CSV: не закрыта кавычка в конце файла');
  if (cur !== '' || row.length > 0) {
    row.push(cur);
    out.push(row);
  }
  return out.filter((r) => !(r.length === 1 && r[0] === ''));
}

const RAW_HEADER = ['snap_id', 'table', 'row', 'field', 'value'];

export function parseQsnapRaw(text: string): QsnapRawRow[] {
  const records = parseCsvRecords(text);
  if (records.length === 0) return [];
  if (records[0].join(',') !== RAW_HEADER.join(',')) {
    throw new QsnapFormatError(
      `qsnap_raw.csv: неожиданная шапка «${records[0].join(',')}», ожидалась «${RAW_HEADER.join(',')}»`,
    );
  }
  const rows: QsnapRawRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const r = records[i];
    if (r.length !== 5) {
      throw new QsnapFormatError(`qsnap_raw.csv: в записи ${i + 1} ${r.length} полей вместо 5`);
    }
    const rowNo = Number(r[2]);
    if (!Number.isInteger(rowNo) || rowNo < 0) {
      throw new QsnapFormatError(`qsnap_raw.csv: в записи ${i + 1} некорректный номер строки «${r[2]}»`);
    }
    rows.push({ snapId: r[0], table: r[1], row: rowNo, field: r[3], value: r[4] });
  }
  return rows;
}

const INDEX_COLUMNS = [
  'snap_id',
  'local_time',
  'server_time',
  'server_time_end',
  'trade_date',
  'connected',
  'quik_version',
  'script_version',
  'status',
  'raw_lines',
  'raw_bytes',
  'float_ids',
  'counts',
  'errors',
] as const;

/** `DD.MM.YYYY` → `YYYY-MM-DD` */
export function ruDateToIso(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

function toInt(raw: string, what: string, line: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new QsnapFormatError(`qsnap_index.csv: строка ${line}, «${what}» = «${raw}» не целое число`);
  }
  return n;
}

export function parseQsnapIndex(text: string): QsnapIndexRow[] {
  const records = parseCsvRecords(text);
  if (records.length === 0) return [];
  const header = records[0];
  const pos = new Map(header.map((h, i) => [h, i]));
  for (const col of INDEX_COLUMNS) {
    if (!pos.has(col)) {
      throw new QsnapFormatError(`qsnap_index.csv: нет колонки «${col}» — формат индекса изменился`);
    }
  }
  const get = (r: string[], col: (typeof INDEX_COLUMNS)[number]): string => r[pos.get(col) as number] ?? '';

  const rows: QsnapIndexRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const r = records[i];
    const line = i + 1;
    const tradeDate = ruDateToIso(get(r, 'trade_date'));
    if (!tradeDate) {
      throw new QsnapFormatError(
        `qsnap_index.csv: строка ${line}, trade_date «${get(r, 'trade_date')}» не в формате ДД.ММ.ГГГГ`,
      );
    }
    const localTime = get(r, 'local_time');
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(localTime)) {
      throw new QsnapFormatError(`qsnap_index.csv: строка ${line}, local_time «${localTime}» не распознан`);
    }
    rows.push({
      snapId: get(r, 'snap_id'),
      localTime,
      serverTime: get(r, 'server_time'),
      serverTimeEnd: get(r, 'server_time_end'),
      tradeDate,
      connected: get(r, 'connected') === '1',
      quikVersion: get(r, 'quik_version'),
      scriptVersion: get(r, 'script_version'),
      status: get(r, 'status'),
      rawLines: toInt(get(r, 'raw_lines'), 'raw_lines', line),
      rawBytes: toInt(get(r, 'raw_bytes'), 'raw_bytes', line),
      floatIds: toInt(get(r, 'float_ids'), 'float_ids', line),
      counts: get(r, 'counts'),
      errors: get(r, 'errors'),
    });
  }
  return rows;
}

/** Разница `local_time − server_time` в секундах, приведённая к (−12ч; +12ч]; null если server_time пуст */
export function clockSkewSec(localTime: string, serverTime: string): number | null {
  const s = serverTime.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  const l = localTime.match(/(\d{2}):(\d{2}):(\d{2})$/);
  if (!s || !l) return null;
  const server = Number(s[1]) * 3600 + Number(s[2]) * 60 + Number(s[3]);
  const local = Number(l[1]) * 3600 + Number(l[2]) * 60 + Number(l[3]);
  return ((((local - server + 43200) % 86400) + 86400) % 86400) - 43200;
}

export interface SnapshotAssessment {
  snapId: string;
  index: QsnapIndexRow;
  /** строк этого snap_id в qsnap_raw.csv */
  rawLinesActual: number;
  /** снимку можно верить: status=ok, raw_lines совпал, float_ids=0 */
  complete: boolean;
  /** почему не целый — человекочитаемо, пусто у целого */
  reasons: string[];
  clockSkewSec: number | null;
}

export interface SnapshotAssessments {
  snapshots: SnapshotAssessment[];
  /** snap_id, которые есть в raw, но у которых нет строки индекса, — незавершённые, в расчёт не идут */
  unfinished: string[];
}

/** Число строк raw по snap_id */
export function countRawLines(rows: Iterable<{ snapId: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.snapId, (counts.get(r.snapId) ?? 0) + 1);
  return counts;
}

/**
 * Проверка целостности по правилам моста:
 *  1) в индексе есть строка снимка со status=ok;
 *  2) raw_lines равно числу строк этого snap_id в raw;
 *  3) float_ids = 0 (иначе номера сделок могли потерять разряды).
 * Неизвестная версия скрипта — ошибка формата, а не «нецелый снимок»: молча
 * интерпретировать чужие поля нельзя.
 */
export function assessSnapshots(
  index: readonly QsnapIndexRow[],
  rawCounts: ReadonlyMap<string, number>,
): SnapshotAssessments {
  const seen = new Set<string>();
  const snapshots: SnapshotAssessment[] = [];
  for (const row of index) {
    if (seen.has(row.snapId)) {
      throw new QsnapFormatError(`qsnap_index.csv: snap_id ${row.snapId} встречается в индексе дважды`);
    }
    seen.add(row.snapId);
    if (!SUPPORTED_SCRIPT_VERSIONS.includes(row.scriptVersion)) {
      throw new QsnapFormatError(
        `Снимок ${row.snapId}: версия скрипта «${row.scriptVersion}» не поддерживается ` +
          `(умею читать: ${SUPPORTED_SCRIPT_VERSIONS.join(', ')}). Нужно обновить разбор в libs/core/src/lib/yv1.`,
      );
    }
    const actual = rawCounts.get(row.snapId) ?? 0;
    const reasons: string[] = [];
    if (row.status !== 'ok') reasons.push(`status=${row.status}`);
    if (row.rawLines !== actual) reasons.push(`raw_lines=${row.rawLines}, в файле ${actual}`);
    if (row.floatIds !== 0) reasons.push(`float_ids=${row.floatIds}`);
    snapshots.push({
      snapId: row.snapId,
      index: row,
      rawLinesActual: actual,
      complete: reasons.length === 0,
      reasons,
      clockSkewSec: clockSkewSec(row.localTime, row.serverTime),
    });
  }
  const unfinished = [...rawCounts.keys()].filter((id) => !seen.has(id)).sort();
  return { snapshots, unfinished };
}

/** Строка таблицы терминала: поля → значения (текстом), плюс номер строки */
export type TableRow = Readonly<Record<string, string>>;
/** Таблицы одного снимка: имя таблицы → строки по возрастанию номера */
export type SnapshotTables = Map<string, TableRow[]>;

/** Pivot (row × field) для каждой таблицы одного снимка; `rows` — только строки ЭТОГО snap_id */
export function pivotSnapshot(rows: Iterable<QsnapRawRow>): SnapshotTables {
  const byTable = new Map<string, Map<number, Record<string, string>>>();
  for (const r of rows) {
    let t = byTable.get(r.table);
    if (!t) byTable.set(r.table, (t = new Map()));
    let rec = t.get(r.row);
    if (!rec) t.set(r.row, (rec = {}));
    rec[r.field] = r.value;
  }
  const out: SnapshotTables = new Map();
  for (const [name, t] of byTable) {
    out.set(
      name,
      [...t.entries()].sort((a, b) => a[0] - b[0]).map(([, rec]) => rec),
    );
  }
  return out;
}
