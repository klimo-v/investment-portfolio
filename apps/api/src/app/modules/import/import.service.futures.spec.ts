import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { instruments, operations, portfolios, quotes, systems } from '../../../db/schema';
import { ImportService } from './import.service';
import { InstrumentIdentityService } from '../instruments/instrument-identity.service';

/**
 * Импорт фьючерсов из HTML-отчёта брокера: инструмент Future, время сделки,
 * расчётная цена в quotes, дедуп по номеру сделки при повторной загрузке и
 * пересечении периодов. Отчёт синтетический (реальные выписки не коммитятся).
 */

const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
type T = [date: string, time: string, side: string, qty: string, price: string, no: string];
const trade = (t: T) => row([t[0], t[0], t[1], 'CNY-12.26', 'фьючерс', t[2], t[3], t[4], '3.69', '1.12', t[5], '']);

function report(trades: T[], periodEnd: string, mark: string): string {
  return `
    <p>Договор на ведение индивидуального инвестиционного счета SESPS от 05.12.2018</p>
    <p>Отчет брокера за период с 27.10.2026<br>по ${periodEnd}</p>
    <p>Срочный рынок Торговый код: SESPS</p>
    <table>${row(['CNY-12.26', 'фьючерс', '', '17.12.2026', '0', '', '-4', mark, '0.00', '0.00'])}</table>
    <p>Срочные сделки</p>
    <table>${trades.map(trade).join('')}</table>`;
}

const T1: T = ['29.10.2026', '13:40:00', 'Покупка', '2', '12.27', '1001'];
const T2: T = ['29.10.2026', '15:00:02', 'Покупка', '2', '12.284', '1002'];
const T3: T = ['30.10.2026', '10:20:00', 'Продажа', '4', '12.328', '1003'];
const T4: T = ['04.11.2026', '13:00:03', 'Продажа', '4', '12.357', '1004'];

let db: BetterSQLite3Database;
let service: ImportService;
const opts = { format: 'html' as const, systemId: 'sys-1', portfolioId: 'pf-1' };

beforeEach(() => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
  db = drizzle(sqlite);
  db.insert(systems).values({ id: 'sys-1', name: 'Тест' }).run();
  db.insert(portfolios).values({ id: 'pf-1', name: 'ИИС' }).run();
  service = new ImportService(db, new InstrumentIdentityService(db));
});

describe('ImportService — фьючерсы', () => {
  it('первый импорт: операции со временем, инструмент Future, расчётная цена в quotes', async () => {
    const res = await service.commit({ ...opts, content: report([T1, T2, T3], '05.11.2026', '12.387') });
    expect(res.imported).toBe(3);

    const ops = db.select().from(operations).all();
    expect(ops).toHaveLength(3);
    const first = ops.find((o) => o.brokerRef === '1001');
    expect(first).toMatchObject({ executedAt: '13:40:00', price: '12270', quantity: '2', operationType: 'Buy', fee: '4.81' });

    const [inst] = db.select().from(instruments).where(eq(instruments.ticker, 'CNY-12.26')).all();
    expect(inst).toMatchObject({ type: 'Future', marketSource: 'manual', currency: 'RUB' });
    expect(inst.name).toContain('17.12.2026');

    const [q] = db.select().from(quotes).where(eq(quotes.instrumentId, inst.id)).all();
    expect(q).toMatchObject({ price: '12387', currency: 'RUB', source: 'broker-report' });
    expect(q.asOf.slice(0, 10)).toBe('2026-11-05');
  });

  it('preview — dry-run: отдаёт марки, но ничего не пишет', async () => {
    const p = await service.preview({ ...opts, content: report([T1], '05.11.2026', '12.387') });
    expect(p.marks).toEqual([{ ticker: 'CNY-12.26', date: '2026-11-05', price: '12387' }]);
    expect(db.select().from(operations).all()).toHaveLength(0);
    expect(db.select().from(quotes).all()).toHaveLength(0);
  });

  it('повторная загрузка того же отчёта дублей не создаёт', async () => {
    const content = report([T1, T2, T3], '05.11.2026', '12.387');
    await service.commit({ ...opts, content });
    const again = await service.preview({ ...opts, content });
    expect(again.summary.duplicate).toBe(3);
    const res = await service.commit({ ...opts, content });
    expect(res.imported).toBe(0);
    expect(db.select().from(operations).all()).toHaveLength(3);
  });

  it('пересекающиеся периоды: общие сделки пропускаются, новая добавляется; более старая цена не затирает свежую', async () => {
    await service.commit({ ...opts, content: report([T1, T2, T3, T4], '05.11.2026', '12.387') });
    // второй отчёт — более ранний период, пересекается тремя сделками
    const res = await service.commit({ ...opts, content: report([T1, T2, T3], '30.10.2026', '12.100') });
    expect(res.imported).toBe(0);
    const [q] = db.select().from(quotes).all();
    expect(q.price).toBe('12387');
    expect(q.asOf.slice(0, 10)).toBe('2026-11-05');

    // третий отчёт — позже; общая сделка T4 и одна новая
    const T5: T = ['06.11.2026', '10:00:00', 'Покупка', '1', '12.4', '1005'];
    const res3 = await service.commit({ ...opts, content: report([T4, T5], '06.11.2026', '12.450') });
    expect(res3.imported).toBe(1);
    expect(db.select().from(operations).all()).toHaveLength(5);
    const [q3] = db.select().from(quotes).all();
    expect(q3.price).toBe('12450');
  });

  it('опцион и неизвестная серия не заводят инструмент в справочнике', async () => {
    const bad = (code: string, kind = 'фьючерс') =>
      row(['04.11.2026', '04.11.2026', '10:00:00', code, kind, 'Покупка', '1', '1.5', '1', '1', code + '-1', '']);
    const html = report([T1], '05.11.2026', '12.387').replace(
      '</table>',
      bad('Si-12.26') + bad('CNY-12.26', 'опцион') + '</table>',
    );
    const res = await service.commit({ ...opts, content: html });
    expect(res.imported).toBe(1);
    const tickers = db.select().from(instruments).all().map((i) => i.ticker);
    expect(tickers).toEqual(['CNY-12.26']);
  });

  it('откат импорта удаляет операции, а цена в quotes остаётся', async () => {
    const { batchId } = await service.commit({ ...opts, content: report([T1], '05.11.2026', '12.387') });
    service.rollback(batchId);
    expect(db.select().from(operations).all()).toHaveLength(0);
    expect(db.select().from(quotes).all()).toHaveLength(1);
  });

  it('uploadId: марки берутся из кэша без повторного разбора файла', async () => {
    const first = await service.preview({ ...opts, content: report([T1], '05.11.2026', '12.387') });
    const second = await service.preview({ ...opts, uploadId: first.uploadId });
    expect(second.marks).toHaveLength(1);
  });
});
