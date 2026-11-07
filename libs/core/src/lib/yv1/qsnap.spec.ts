import { describe, expect, it } from 'vitest';
import {
  QsnapFormatError,
  assessSnapshots,
  clockSkewSec,
  countRawLines,
  parseCsvRecords,
  parseQsnapIndex,
  parseQsnapRaw,
  pivotSnapshot,
} from './qsnap';

/**
 * Разбор файлов моста и правила целостности. Фикстуры — обезличенные: в них нет номера
 * счёта, кода клиента и ФИО, только форма данных и реальные числа из снимков.
 */

const INDEX_HEADER =
  'snap_id,local_time,server_time,server_time_end,trade_date,connected,quik_version,script_version,status,raw_lines,raw_bytes,float_ids,counts,errors';

const indexRow = (o: Partial<Record<string, string>> = {}): string => {
  const r = {
    snap_id: '20261107_022914',
    local_time: '2026-11-07 02:29:14',
    server_time: '1:58:54',
    server_time_end: '1:58:54',
    trade_date: '06.11.2026',
    connected: '1',
    quik_version: '12.8.4.9',
    script_version: '3',
    status: 'ok',
    raw_lines: '3',
    raw_bytes: '100',
    float_ids: '0',
    counts: 'trades[n=1 ok=1 fail=0];orders[n=1 ok=1 fail=0]',
    errors: '',
    ...o,
  };
  const quote = (v: string): string => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return Object.values(r).map(quote).join(',');
};

const RAW = [
  'snap_id,table,row,field,value',
  '20261107_022914,trades,0,qty,5',
  '20261107_022914,trades,0,price,12.405',
  '20261107_022914,trades,1,qty,100',
].join('\n');

describe('parseCsvRecords', () => {
  it('понимает кавычки, удвоенные кавычки и запятые внутри значения', () => {
    expect(parseCsvRecords('a,"b,c","d""e"\n1,2,3\n')).toEqual([
      ['a', 'b,c', 'd"e'],
      ['1', '2', '3'],
    ]);
  });

  it('переводы строк внутри кавычек остаются в значении, \\r\\n в конце строки отбрасывается', () => {
    expect(parseCsvRecords('a,"x\ny"\r\nb,c\r\n')).toEqual([
      ['a', 'x\ny'],
      ['b', 'c'],
    ]);
  });

  it('незакрытая кавычка — ошибка формата, а не молчаливо обрезанные данные', () => {
    expect(() => parseCsvRecords('a,"b\n')).toThrow(QsnapFormatError);
  });
});

describe('parseQsnapRaw / parseQsnapIndex', () => {
  it('19-значные номера остаются строкой без потери разрядов', () => {
    const rows = parseQsnapRaw(
      'snap_id,table,row,field,value\n20261107_022914,trades,0,trade_num,2022430714489774749\n',
    );
    expect(rows[0].value).toBe('2022430714489774749');
    expect(rows[0].row).toBe(0);
  });

  it('падает на изменившейся шапке и на записи с лишним полем', () => {
    expect(() => parseQsnapRaw('snap_id,table,row,field\n')).toThrow(/шапка/);
    expect(() => parseQsnapRaw('snap_id,table,row,field,value\na,b,0,c,d,e\n')).toThrow(/полей/);
  });

  it('индекс: дата ДД.ММ.ГГГГ → ISO, числа приводятся, недостающая колонка — понятная ошибка', () => {
    const [r] = parseQsnapIndex(`${INDEX_HEADER}\n${indexRow()}\n`);
    expect(r.tradeDate).toBe('2026-11-06');
    expect(r.rawLines).toBe(3);
    expect(r.connected).toBe(true);
    expect(() => parseQsnapIndex('snap_id,local_time\nx,y\n')).toThrow(/нет колонки/);
  });
});

describe('clockSkewSec', () => {
  it('сервер отстаёт на ~30 минут (как в реальных снимках)', () => {
    expect(clockSkewSec('2026-11-07 02:29:14', '1:58:54')).toBe(1820);
    expect(clockSkewSec('2026-11-07 00:54:30', '0:24:10')).toBe(1820);
  });

  it('через полночь разница приводится к ближайшей, а не к ~23.5 часам', () => {
    expect(clockSkewSec('2026-11-07 00:10:00', '23:40:00')).toBe(1800);
  });

  it('пустое время сервера — null', () => {
    expect(clockSkewSec('2026-11-07 00:10:00', '')).toBeNull();
  });
});

describe('assessSnapshots — когда снимку можно верить', () => {
  const raw = parseQsnapRaw(RAW);
  const counts = countRawLines(raw);

  it('целый: status=ok, raw_lines совпал, float_ids=0', () => {
    const { snapshots, unfinished } = assessSnapshots(parseQsnapIndex(`${INDEX_HEADER}\n${indexRow()}\n`), counts);
    expect(snapshots[0].complete).toBe(true);
    expect(snapshots[0].reasons).toEqual([]);
    expect(unfinished).toEqual([]);
  });

  it('число строк не сходится — не целый, причина названа', () => {
    const { snapshots } = assessSnapshots(parseQsnapIndex(`${INDEX_HEADER}\n${indexRow({ raw_lines: '4' })}\n`), counts);
    expect(snapshots[0].complete).toBe(false);
    expect(snapshots[0].reasons[0]).toMatch(/raw_lines=4, в файле 3/);
  });

  it('status≠ok и float_ids>0 — не целый', () => {
    const idx = parseQsnapIndex(`${INDEX_HEADER}\n${indexRow({ status: 'ERROR', float_ids: '2' })}\n`);
    const { snapshots } = assessSnapshots(idx, counts);
    expect(snapshots[0].complete).toBe(false);
    expect(snapshots[0].reasons).toEqual(['status=ERROR', 'float_ids=2']);
  });

  it('snap_id без строки индекса — незавершённый, не снимок', () => {
    const { snapshots, unfinished } = assessSnapshots([], counts);
    expect(snapshots).toEqual([]);
    expect(unfinished).toEqual(['20261107_022914']);
  });

  it('неизвестная версия скрипта — ошибка с понятным текстом, а не молчаливый разбор', () => {
    const idx = parseQsnapIndex(`${INDEX_HEADER}\n${indexRow({ script_version: '9' })}\n`);
    expect(() => assessSnapshots(idx, counts)).toThrow(/версия скрипта «9» не поддерживается/);
  });

  it('версии 2 и 3 читаются', () => {
    for (const v of ['2', '3']) {
      const idx = parseQsnapIndex(`${INDEX_HEADER}\n${indexRow({ script_version: v })}\n`);
      expect(assessSnapshots(idx, counts).snapshots[0].complete).toBe(true);
    }
  });
});

describe('pivotSnapshot', () => {
  it('собирает таблицу (row × field) с упорядочиванием по номеру строки', () => {
    const tables = pivotSnapshot(parseQsnapRaw(RAW));
    expect(tables.get('trades')).toEqual([
      { qty: '5', price: '12.405' },
      { qty: '100' },
    ]);
  });
});
