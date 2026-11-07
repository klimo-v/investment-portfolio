import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { instruments, operationAnnotations, operations, portfolios, quotes, systems } from '../../../db/schema';
import { OperationsService } from '../operations/operations.service';
import { SystemPerformanceService } from '../portfolios/system-performance.service';
import type { QuotesService } from '../quotes/quotes.service';
import { AnnotationImportService } from './annotation-import.service';

/**
 * Аннотации исполнения из CSV QUIK на эталонных сделках CNY-12.26 (номер сделки в
 * отчёте = trade_num в выгрузке). Комиссии выгрузки в журнал не попадают никогда.
 */
const quotesStub = { getFxRate: async () => 1 } as unknown as QuotesService;

type T = [date: string, time: string, side: 'Buy' | 'Sell', qty: string, price: string, fee: string, ref: string];
const TRADES: T[] = [
  ['2026-10-29', '13:40:00', 'Buy', '2', '12270', '4.81', '1001'],
  ['2026-10-29', '15:00:02', 'Buy', '2', '12284', '4.81', '1002'],
  ['2026-10-30', '10:20:00', 'Sell', '4', '12328', '9.68', '1003'],
  ['2026-11-04', '13:00:03', 'Sell', '4', '12357', '9.70', '1004'],
  ['2026-11-04', '13:00:03', 'Sell', '3', '12357', '7.28', '1005'],
  ['2026-11-04', '13:00:03', 'Sell', '58', '12357', '140.57', '1006'],
  ['2026-11-04', '15:00:02', 'Sell', '65', '12340', '157.37', '1007'],
  ['2026-11-05', '10:20:01', 'Buy', '81', '12467', '197.65', '1008'],
  ['2026-11-05', '10:20:01', 'Buy', '25', '12467', '61.01', '1009'],
  ['2026-11-05', '10:20:01', 'Buy', '20', '12467', '48.81', '1010'],
  ['2026-11-05', '10:20:01', 'Buy', '4', '12467', '9.77', '1011'],
  ['2026-11-05', '13:00:04', 'Sell', '64', '12421', '155.73', '1012'],
  ['2026-11-05', '15:00:03', 'Sell', '52', '12420', '126.52', '1013'],
  ['2026-11-05', '15:00:03', 'Sell', '12', '12420', '29.20', '1014'],
];

const HEADER =
  'date,time,contract,side,qty,price,reason,ref_price,slip_rub,slip_pct,broker_fee_quik,exchange_fee,clearing_fee,techcenter_fee,order_num,trade_num';
// сделка 1012: Sell 64 @ 12 421, сигнал 12 422; комиссия терминала 314.71 (оценка, в журнал не идёт)
const ROW_1012 = '2026-11-05,13:00:04,CRZ6,S,64,12.421,h1,12.422,64.00,0.0081,314.71,21.12,15.36,0.00,2022430710194950984,1012';
// сделка 1001: Buy 2 @ 12 270, сигнал 12 268
const ROW_1001 = '2026-10-29,13:40:00,CRZ6,B,2,12.27,h2,12.268,-4.00,0.0,19.54,1,1,0,1,1001';
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

describe('AnnotationImportService', () => {
  let db: BetterSQLite3Database;
  let service: AnnotationImportService;

  beforeEach(() => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
    db = drizzle(sqlite);
    db.insert(systems).values({ id: 'sys', name: 'ЮВ1' }).run();
    db.insert(portfolios).values({ id: 'pf', name: 'ИИС' }).run();
    db.insert(instruments)
      .values({ id: 'CNY-12.26', ticker: 'CNY-12.26', type: 'Future', currency: 'RUB', marketSource: 'manual' })
      .run();
    db.insert(quotes)
      .values({ instrumentId: 'CNY-12.26', price: '12387', currency: 'RUB', source: 'manual', asOf: '2026-11-05T00:00:00.000Z' })
      .run();
    db.insert(operations)
      .values(
        TRADES.map((t) => ({
          id: randomUUID(),
          date: t[0],
          executedAt: t[1],
          systemId: 'sys',
          portfolioId: 'pf',
          instrumentId: 'CNY-12.26',
          operationType: t[2],
          quantity: t[3],
          price: t[4],
          fee: t[5],
          currency: 'RUB',
          brokerRef: t[6],
        })),
      )
      .run();
    service = new AnnotationImportService(db);
  });

  it('предпросмотр: сопоставленные строки и ошибки с причинами; в базу ничего не пишет', () => {
    const p = service.preview({
      content: csv(
        ROW_1012,
        ROW_1012.replace(/,1012$/, ',7777'), // нет такой сделки (позиция открыта до начала отчёта)
        ROW_1012.replace('CRZ6', 'SiZ6'), // неизвестный контракт
      ),
    });
    expect(p.summary).toEqual({ total: 3, matched: 1, error: 2 });
    expect(p.rows.map((r) => r.status)).toEqual(['matched', 'error', 'error']);
    expect(p.rows[1].reason).toContain('7777');
    expect(p.rows[2].reason).toContain('SiZ6');
    expect(p.rows[0]).toMatchObject({ tag: 'h1', signalPrice: '12422', price: '12421', ticker: 'CNY-12.26' });
    expect(db.select().from(operationAnnotations).all()).toHaveLength(0);
  });

  it('commit: аннотация сохранена, операции и комиссия отчёта не изменены; повтор идемпотентен', () => {
    const before = db.select().from(operations).all();
    const res = service.commit({ content: csv(ROW_1012, ROW_1001, ROW_1012.replace(/,1012$/, ',7777')) });
    expect(res.saved).toBe(2);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].reason).toContain('7777');

    const ann = db.select().from(operationAnnotations).all();
    expect(ann).toHaveLength(2);
    const op1012 = db.select().from(operations).where(eq(operations.brokerRef, '1012')).all()[0];
    expect(ann.find((a) => a.operationId === op1012.id)).toMatchObject({ tag: 'h1', signalPrice: '12422', source: 'quik-trades' });

    // факт комиссии — отчёт брокера (155.73), а не оценка терминала (314.71 + …)
    expect(op1012.fee).toBe('155.73');
    expect(db.select().from(operations).all()).toEqual(before);

    service.commit({ content: csv(ROW_1012, ROW_1001) });
    expect(db.select().from(operationAnnotations).all()).toHaveLength(2);
  });

  it('удаление операции удаляет её аннотацию (каскад)', () => {
    service.commit({ content: csv(ROW_1012) });
    db.delete(operations).where(eq(operations.brokerRef, '1012')).run();
    expect(db.select().from(operationAnnotations).all()).toHaveLength(0);
  });

  it('неизвестный формат — 400', () => {
    expect(() => service.preview({ content: csv(ROW_1012), format: 'nope' })).toThrow(/Неизвестный формат/);
  });

  it('статистика системы: блок «Исполнение» появляется только после загрузки аннотаций', async () => {
    const perf = new SystemPerformanceService(db, new OperationsService(db, quotesStub));
    expect((await perf.performance('sys', {})).execution).toBeNull();

    service.commit({ content: csv(ROW_1012, ROW_1001) });
    const e = (await perf.performance('sys', {})).execution!;
    // 1012: (12 422 − 12 421) × 64 = 64; 1001: (12 270 − 12 268) × 2 = 4
    expect(e.fills).toBe(2);
    expect(e.totalSlippageRub).toBe('68.00');
    expect(e.byTag.map((t) => [t.tag, t.slippageRub])).toEqual([
      ['h1', '64.00'],
      ['h2', '4.00'],
    ]);
    // тег входа закрытой сделки: цикл 0 (лонг) вошёл по 1001 → h2
    expect(e.byEntryTag).toEqual([
      { tag: null, trades: 1, wins: 0, winRatePct: 0, netPnlRub: '-16037.16' }, // шорт без аннотации входа
      { tag: 'h2', trades: 1, wins: 1, winRatePct: 100, netPnlRub: '184.70' },
    ]);
  });
});
