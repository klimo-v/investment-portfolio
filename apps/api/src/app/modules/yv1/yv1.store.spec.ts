import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QsnapFormatError } from '@core';
import { eq } from 'drizzle-orm';
import { portfolioSnapshots, portfolios, qsnapRaw, qsnapSnapshots, snapshotInvalidations, strategyConfigs, strategyDailyResults, systems, yv1AutomatTrades } from '../../../db/schema';
import { Yv1Store, type Yv1Paths } from './yv1.store';
import { loadStrategyContext } from './strategy-context';

/**
 * Импорт моста и журнала автомата во временную БД. Каталог моста — временный, с
 * обезличенными файлами (ни счёта, ни кода клиента): мы проверяем идемпотентность,
 * отказ от нецелых снимков и то, что файлы моста не меняются.
 */

const SNAP = '20261107_022914';

/** Минимальный набор таблиц снимка: 3 сделки выхода CRZ6, заявка, позиция, деньги */
function rawFor(snapId: string): string[] {
  const out: string[] = [];
  const put = (table: string, row: number, o: Record<string, string>): void => {
    for (const [f, v] of Object.entries(o)) out.push(`${snapId},${table},${row},${f},${v}`);
  };
  const trade = (row: number, num: string, qty: string, value: string): void =>
    put('trades', row, {
      trade_num: num,
      order_num: 'O1',
      account: 'ACC1',
      class_code: 'SPBFUT',
      sec_code: 'CRZ6',
      'datetime.year': '2026',
      'datetime.month': '11',
      'datetime.day': '6',
      'datetime.hour': '10',
      'datetime.min': '20',
      'datetime.sec': '0',
      'datetime.ms': '939',
      qty,
      price: '12.405',
      value,
      broker_comission: '1',
      exchange_comission: '1',
      clearing_comission: '1',
      tech_center_comission: '0',
      flags: '64',
    });
  trade(0, '2022430714489774749', '5', '62025');
  trade(1, '2022430714489774750', '100', '1240500');
  trade(2, '2022430714489774751', '23', '285315');
  put('orders', 0, { order_num: 'O1', flags: '24' });
  put('futures_client_holding', 0, { trdaccid: 'ACC1', sec_code: 'CRZ6', startnet: '-128', totalnet: '0', varmargin: '-2304', real_varmargin: '0', total_varmargin: '0' });
  put('money_limits', 0, { client_code: 'CL1', currcode: 'SUR', limit_kind: '0', openbal: '4297.96', currentbal: '4297.96' });
  put('money_limits', 1, { client_code: 'CL1', currcode: 'SUR', limit_kind: '1', openbal: '4297.96', currentbal: '4297.96' });
  return out;
}

const INDEX_HEADER =
  'snap_id,local_time,server_time,server_time_end,trade_date,connected,quik_version,script_version,status,raw_lines,raw_bytes,float_ids,counts,errors';
const indexLine = (snapId: string, rawLines: number, extra: { status?: string; errors?: string } = {}): string =>
  `${snapId},2026-11-07 02:29:14,1:58:54,1:58:54,06.11.2026,1,12.8.4.9,3,${extra.status ?? 'ok'},${rawLines},1,0,,${extra.errors ?? ''}`;

const AUTOMAT_TRADES = `date,time,contract,side,qty,price,reason,ref_price,slip_rub,slip_pct,broker_fee_quik,exchange_fee,clearing_fee,techcenter_fee,order_num,trade_num
2026-11-05,13:00:04,CRZ6,S,64,12.421,h1,12.422,64.00,0.0081,314.71,21.12,15.36,0.00,2022430710197636722,2022430710194950984
2026-11-05,15:00:03,CRZ6,S,64,12.42,h2,12.42,0.00,0.0000,255.69,17.16,12.48,0.00,2022430710198487455,2022430710195027611
2026-11-06,10:20:00,CRZ6,B,5,12.405,exit,,,,1,1,1,0.00,O1,2022430714489774749
2026-11-06,10:20:00,CRZ6,B,100,12.405,exit,,,,1,1,1,0.00,O1,2022430714489774750
2026-11-06,10:20:00,CRZ6,B,23,12.405,exit,,,,1,1,1,0.00,O1,2022430714489774751
`;

/** cp1251 для кириллицы А–я: достаточно, чтобы проверить, что файл декодируется как cp1251 */
function cp1251(text: string): Buffer {
  return Buffer.from(
    [...text].map((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 0x410 && c <= 0x44f ? c - 0x410 + 0xc0 : c;
    }),
  );
}

function hashDir(dir: string): string {
  const h = createHash('sha256');
  for (const n of readdirSync(dir).sort()) h.update(n).update(readFileSync(join(dir, n)));
  return h.digest('hex');
}

/** Стратегия ЮВ1 как в рабочей БД: система + конфиг quik-bridge с префиксом по умолчанию */
function seedYv1(db: BetterSQLite3Database): string {
  db.insert(systems).values({ id: 'yv1-sys', name: 'ЮВ1-2вх' }).run();
  db.insert(strategyConfigs).values({ systemId: 'yv1-sys', adapter: 'quik-bridge' }).run();
  return 'yv1-sys';
}

describe('Yv1Store — импорт моста', () => {
  let dir: string;
  let db: BetterSQLite3Database;
  let store: Yv1Store;

  const writeBridge = (opts: { snaps: { id: string; rawLines?: number; status?: string; errors?: string; skipRaw?: boolean; skipIndex?: boolean }[] }): void => {
    const raw: string[] = [];
    const idx: string[] = [INDEX_HEADER];
    for (const s of opts.snaps) {
      const lines = rawFor(s.id);
      if (!s.skipRaw) raw.push(...lines);
      if (!s.skipIndex) idx.push(indexLine(s.id, s.rawLines ?? lines.length, { status: s.status, errors: s.errors }));
    }
    writeFileSync(join(dir, 'qsnap_raw.csv'), cp1251(['snap_id,table,row,field,value', ...raw].join('\n') + '\n'));
    writeFileSync(join(dir, 'qsnap_index.csv'), cp1251(idx.join('\n') + '\n'));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yv1-bridge-'));
    writeFileSync(join(dir, 'yv1_trades.csv'), AUTOMAT_TRADES);
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
    db = drizzle(sqlite);
    seedYv1(db);
    const paths: Yv1Paths = { bridgeDir: dir, backtestCsv: null, corridorFile: null };
    store = new Yv1Store(db, paths);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('целый снимок импортируется со всем сырьём, ключи сделок не теряют разрядов', () => {
    writeBridge({ snaps: [{ id: SNAP }] });
    const r = store.importSnapshots();
    expect(r.imported).toEqual([SNAP]);
    const nums = db.select().from(qsnapRaw).all().filter((x) => x.field === 'trade_num').map((x) => x.value);
    expect(nums).toContain('2022430714489774749');
    expect(db.select().from(qsnapRaw).all()).toHaveLength(rawFor(SNAP).length);
  });

  it('повторный импорт того же файла идемпотентен: ничего не дублируется', () => {
    writeBridge({ snaps: [{ id: SNAP }] });
    store.refresh();
    const before = { raw: db.select().from(qsnapRaw).all().length, snaps: db.select().from(qsnapSnapshots).all().length };
    const again = store.refresh();
    expect(again.snapshots.imported).toEqual([]);
    expect(again.snapshots.alreadyImported).toBe(1);
    expect(db.select().from(qsnapRaw).all()).toHaveLength(before.raw);
    expect(db.select().from(qsnapSnapshots).all()).toHaveLength(before.snaps);
  });

  it('новый снимок в дописанном файле добавляется, старые не трогаются', () => {
    writeBridge({ snaps: [{ id: SNAP }] });
    store.refresh();
    writeBridge({ snaps: [{ id: SNAP }, { id: '20261109_100000' }] });
    const r = store.importSnapshots();
    expect(r.imported).toEqual(['20261109_100000']);
    expect(r.alreadyImported).toBe(1);
  });

  it('нецелый снимок (raw_lines не сходится) в журнале виден, но сырьё не импортируется', () => {
    writeBridge({ snaps: [{ id: SNAP, rawLines: 999 }] });
    const r = store.importSnapshots();
    expect(r.incomplete[0].snapId).toBe(SNAP);
    expect(r.incomplete[0].reasons[0]).toMatch(/raw_lines=999/);
    expect(db.select().from(qsnapSnapshots).all()[0].complete).toBe(0);
    expect(db.select().from(qsnapRaw).all()).toHaveLength(0);
    expect(store.overview('2026-11-07 03:00:00').counts.snapshotsComplete).toBe(0);
  });

  it('снимок со status≠ok не импортируется как целый', () => {
    writeBridge({ snaps: [{ id: SNAP, status: 'NOT_CONNECTED' }] });
    store.importSnapshots();
    expect(db.select().from(qsnapRaw).all()).toHaveLength(0);
  });

  it('снимок без строки индекса — незавершённый: не импортируется, виден в обзоре', () => {
    writeBridge({ snaps: [{ id: SNAP }, { id: '20261109_100000', skipIndex: true }] });
    const r = store.importSnapshots();
    expect(r.unfinished).toEqual(['20261109_100000']);
    expect(db.select().from(qsnapSnapshots).all().map((s) => s.snapId)).toEqual([SNAP]);
    expect(store.overview('2026-11-09 11:00:00').bridge.unfinished).toEqual(['20261109_100000']);
  });

  it('уже импортированный снимок, изменившийся в файле, не перезаписывается — это конфликт', () => {
    writeBridge({ snaps: [{ id: SNAP }] });
    store.importSnapshots();
    writeBridge({ snaps: [{ id: SNAP, rawLines: 5 }] });
    const r = store.importSnapshots();
    expect(r.conflicts).toEqual([SNAP]);
    expect(db.select().from(qsnapSnapshots).all()[0].rawLines).toBe(rawFor(SNAP).length);
  });

  it('неизвестная версия скрипта — понятная ошибка, в БД ничего не пишется', () => {
    writeBridge({ snaps: [{ id: SNAP }] });
    writeFileSync(
      join(dir, 'qsnap_index.csv'),
      readFileSync(join(dir, 'qsnap_index.csv'), 'utf-8').replace(',3,ok,', ',7,ok,'),
    );
    expect(() => store.importSnapshots()).toThrow(QsnapFormatError);
    expect(db.select().from(qsnapSnapshots).all()).toHaveLength(0);
  });

  it('кириллица в индексе читается как cp1251', () => {
    writeBridge({ snaps: [{ id: SNAP, errors: 'нет данных' }] });
    store.importSnapshots();
    expect(db.select().from(qsnapSnapshots).all()[0].errors).toBe('нет данных');
  });

  it('файлы моста при импорте не меняются (только чтение)', () => {
    writeBridge({ snaps: [{ id: SNAP }] });
    const before = hashDir(dir);
    store.refresh();
    store.refresh();
    expect(hashDir(dir)).toBe(before);
  });

  it('число сделок ТС в обзоре совпадает с журналом автомата, сверка с мостом без расхождений по сделкам', () => {
    writeBridge({ snaps: [{ id: SNAP }] });
    store.refresh();
    const o = store.overview('2026-11-07 03:00:00');
    expect(o.counts.yv1).toBe(5); // 5 строк в yv1_trades.csv
    expect(o.counts.unallocated).toBe(0);
    expect(o.discrepancies.filter((d) => d.kind.startsWith('mismatch') || d.kind === 'only-in-automat' || d.kind === 'only-in-bridge')).toEqual([]);
    expect(o.cycles[0]).toMatchObject({ id: '2026-11-05', status: 'closed', closeDate: '2026-11-06' });
  });

  it('refresh пишет ленту результата по закрытым циклам; повтор не дублирует и подхватывает правки', () => {
    writeBridge({ snaps: [{ id: SNAP }] });
    const r = store.refresh();
    expect(r.resultDays).toBe(1);
    const rows = db.select().from(strategyDailyResults).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ systemId: store.ctx.systemId, date: '2026-11-06', cycles: 1 });
    const cycleNet = store.overview('2026-11-07 03:00:00').cycles[0].netRub;
    expect(rows[0].netRub).toBe(Number(cycleNet).toFixed(2));

    store.refresh();
    expect(db.select().from(strategyDailyResults).all()).toHaveLength(1);

    // исчезла сделка выхода из журнала и из БД — лента пересобирается без устаревшего дня
    db.delete(yv1AutomatTrades).run();
    store.materializeResults();
    expect(db.select().from(strategyDailyResults).all()).toHaveLength(0);
  });

  it('лента результата, изменённая задним числом, помечает уже снятые снимки недостоверными', () => {
    writeBridge({ snaps: [{ id: SNAP }] });
    db.insert(portfolioSnapshots).values({ date: '2026-11-10', investedRub: '0', currentValueRub: '0', pnlRub: '0', dividendsRub: '0' }).run();
    store.refresh(); // день 2026-11-06 появился в ленте, а снимок от 11-10 его не видел
    const inv = () => db.select().from(snapshotInvalidations).all();
    expect(inv()).toHaveLength(1);
    expect(inv()[0]).toMatchObject({ kind: 'strategy-sync', operationDate: '2026-11-06' });

    store.refresh(); // ничего не изменилось — новых предупреждений нет
    expect(inv()).toHaveLength(1);

    db.delete(yv1AutomatTrades).run(); // день исчез из ленты — тоже изменение
    store.materializeResults();
    expect(inv()).toHaveLength(2);
  });

  it('настройки: капитал задаётся, сбрасывается null-ом, мусор не принимается', () => {
    expect(store.getSettings().initialCapital).toBeNull();
    expect(store.updateSettings({ initialCapital: '1288500' }).initialCapital).toBe('1288500');
    expect(store.updateSettings({ initialCapital: null }).initialCapital).toBeNull();
  });

  it('кривая в CSV: без капитала — ошибка с объяснением, с капиталом — шапка date,ret,equity', () => {
    writeBridge({ snaps: [{ id: SNAP }] });
    store.refresh();
    expect(() => store.curveCsv('2026-11-07 03:00:00')).toThrow(/начальный капитал/);
    store.updateSettings({ initialCapital: '1288500' });
    expect(store.curveCsv('2026-11-07 03:00:00').split('\n')[0]).toBe('date,ret,equity');
  });
});

describe('Yv1Store — несколько стратегий на одном мосте', () => {
  let dir: string;
  let db: BetterSQLite3Database;
  let paths: Yv1Paths;
  let storeA: Yv1Store;

  const TRADES_HEADER = 'date,time,contract,side,qty,price,reason,ref_price,slip_rub,slip_pct,broker_fee_quik,exchange_fee,clearing_fee,techcenter_fee,order_num,trade_num';
  const trade = (num: string): string => `2026-11-06,10:20:00,CRZ6,B,5,12.405,exit,,,,1,1,1,0.00,O1,${num}`;

  const addStrategy = (id: string, prefix: string, portfolioId: string | null = null): void => {
    db.insert(systems).values({ id, name: id }).run();
    db.insert(strategyConfigs).values({ systemId: id, portfolioId, adapter: 'quik-bridge', params: JSON.stringify({ journalPrefix: prefix }) }).run();
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yv1-multi-'));
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
    db = drizzle(sqlite);
    paths = { bridgeDir: dir, backtestCsv: null, corridorFile: null };
    seedYv1(db);
    storeA = new Yv1Store(db, paths);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('конфиг без params берёт префикс журнала по умолчанию — yv1', () => {
    expect(storeA.ctx.params.journalPrefix).toBe('yv1');
    expect(db.select().from(systems).where(eq(systems.id, storeA.ctx.systemId)).get()?.name).toBe('ЮВ1-2вх');
  });

  it('чистая БД после миграций: ни системы, ни стратегии (фантомной ЮВ1 нет); Yv1Store отказывает понятно', () => {
    const sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
    const clean = drizzle(sqlite);
    expect(clean.select().from(systems).all()).toHaveLength(0);
    expect(clean.select().from(strategyConfigs).all()).toHaveLength(0);
    expect(() => new Yv1Store(clean, paths)).toThrow(/Нет ни одной стратегии/);
  });

  it('при двух стратегиях без systemId — понятная ошибка; с systemId — нужная', () => {
    addStrategy('sys-b', 'zz');
    expect(() => loadStrategyContext(db)).toThrow(/несколько/);
    expect(loadStrategyContext(db, 'sys-b').params.journalPrefix).toBe('zz');
    expect(() => loadStrategyContext(db, 'нет-такой')).toThrow(/не найден/);
  });

  it('журналы читаются по префиксу стратегии и не смешиваются; настройки раздельные', () => {
    addStrategy('sys-b', 'zz');
    writeFileSync(join(dir, 'yv1_trades.csv'), `${TRADES_HEADER}\n${trade('111')}\n`);
    writeFileSync(join(dir, 'zz_trades.csv'), `${TRADES_HEADER}\n${trade('222')}\n${trade('333')}\n`);
    const storeB = new Yv1Store(db, paths, 'sys-b');
    expect(storeA.importAutomat().trades).toBe(1);
    expect(storeB.importAutomat().trades).toBe(2);

    const by = (id: string): string[] =>
      db.select().from(yv1AutomatTrades).where(eq(yv1AutomatTrades.systemId, id)).all().map((t) => t.tradeNum).sort();
    expect(by(storeA.ctx.systemId)).toEqual(['111']);
    expect(by('sys-b')).toEqual(['222', '333']);

    storeA.updateSettings({ initialCapital: '100' });
    expect(storeB.getSettings().initialCapital).toBeNull();
    expect(storeA.getSettings().initialCapital).toBe('100');
  });

  it('сделка, уже записанная за другой стратегией, не отбирается — попадает в skipped', () => {
    addStrategy('sys-b', 'zz');
    writeFileSync(join(dir, 'yv1_trades.csv'), `${TRADES_HEADER}\n${trade('111')}\n`);
    writeFileSync(join(dir, 'zz_trades.csv'), `${TRADES_HEADER}\n${trade('111')}\n${trade('222')}\n`);
    storeA.importAutomat();
    const rB = new Yv1Store(db, paths, 'sys-b').importAutomat();
    expect(rB.trades).toBe(1);
    expect(rB.skipped.join()).toMatch(/111.*другой стратегии/);
    expect(db.select().from(yv1AutomatTrades).where(eq(yv1AutomatTrades.tradeNum, '111')).get()?.systemId).toBe(storeA.ctx.systemId);
  });

  it('повторный импорт стратегии не затирает данные соседней', () => {
    addStrategy('sys-b', 'zz');
    writeFileSync(join(dir, 'yv1_trades.csv'), `${TRADES_HEADER}\n${trade('111')}\n`);
    writeFileSync(join(dir, 'zz_trades.csv'), `${TRADES_HEADER}\n${trade('222')}\n`);
    const storeB = new Yv1Store(db, paths, 'sys-b');
    storeA.importAutomat();
    storeB.importAutomat();
    storeA.importAutomat();
    expect(db.select().from(yv1AutomatTrades).all()).toHaveLength(2);
  });

  it('две стратегии на одном счёте: сделки соседа — не «не распределено» ни у одной, тест полноты сходится', () => {
    const snap = '20261107_022914';
    const idx = `snap_id,local_time,server_time,server_time_end,trade_date,connected,quik_version,script_version,status,raw_lines,raw_bytes,float_ids,counts,errors\n${indexLine(snap, rawFor(snap).length)}\n`;
    writeFileSync(join(dir, 'qsnap_raw.csv'), ['snap_id,table,row,field,value', ...rawFor(snap)].join('\n') + '\n');
    writeFileSync(join(dir, 'qsnap_index.csv'), idx);
    addStrategy('sys-b', 'zz');
    // в снимке три сделки выхода: две принадлежат ЮВ1, одна — второй стратегии
    writeFileSync(join(dir, 'yv1_trades.csv'), `${TRADES_HEADER}\n${trade('2022430714489774749')}\n${trade('2022430714489774750')}\n`);
    writeFileSync(join(dir, 'zz_trades.csv'), `${TRADES_HEADER}\n${trade('2022430714489774751')}\n`);
    const storeB = new Yv1Store(db, paths, 'sys-b');
    storeA.importSnapshots();
    storeA.importAutomat();
    storeB.importAutomat();

    const now = '2026-11-07 03:00:00';
    const a = storeA.overview(now);
    const b = storeB.overview(now);
    expect(a.counts).toMatchObject({ yv1: 2, unallocated: 0, otherStrategy: 1 });
    expect(b.counts).toMatchObject({ yv1: 1, unallocated: 0, otherStrategy: 2 });
    for (const o of [a, b]) {
      expect(o.discrepancies.some((d) => d.kind === 'manual-trade')).toBe(false);
      expect(o.completeness[0].components.find((c) => c.group === 'unallocated')?.amountRub).toBe('0.00');
      expect(o.completeness[0].residual).toBe(storeA.overview(now).completeness[0].residual);
    }
  });

  it('снимки — данные счёта: стратегия на другом портфеле видит те же снимки, а пометка происхождения не меняется', () => {
    const snap = '20261107_022914';
    const idx = `snap_id,local_time,server_time,server_time_end,trade_date,connected,quik_version,script_version,status,raw_lines,raw_bytes,float_ids,counts,errors\n${indexLine(snap, rawFor(snap).length)}\n`;
    writeFileSync(join(dir, 'qsnap_raw.csv'), ['snap_id,table,row,field,value', ...rawFor(snap)].join('\n') + '\n');
    writeFileSync(join(dir, 'qsnap_index.csv'), idx);

    db.insert(portfolios).values([{ id: 'p1', name: 'Trader' }, { id: 'p2', name: 'Другой' }]).run();
    storeA.linkPortfolio('p1');
    storeA.importSnapshots();
    expect(db.select().from(qsnapSnapshots).all()[0].portfolioId).toBe('p1');

    addStrategy('sys-b', 'zz', 'p2');
    const storeB = new Yv1Store(db, paths, 'sys-b');
    storeB.importSnapshots(); // уже импортирован — не перетегируется
    expect(db.select().from(qsnapSnapshots).all()[0].portfolioId).toBe('p1');
    expect(storeB.overview('2026-11-07 03:00:00').counts.snapshotsComplete).toBe(1);
    expect(storeA.overview('2026-11-07 03:00:00').counts.snapshotsComplete).toBe(1);
  });
});
