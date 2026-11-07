import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RawRow } from '@core';
import { futuresSettlements, operations, portfolios, portfolioSnapshots, snapshotInvalidations, systems } from '../../../db/schema';
import { ImportService } from './import.service';

/**
 * Повторный импорт ОБНОВЛЯЕТ операцию, а не только пропускает: комиссия, пришедшая позже
 * или изменившаяся, правит существующую операцию по номеру у брокера. Разметка
 * пользователя (система, заметки) не трогается. Отчёт синтетический.
 */
const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;

/** Одна срочная сделка отчёта; комиссия брокера и биржи задаются явно */
function report(feeBroker: string, vm = ['0.00', '0.00']): string {
  return `
    <p>Договор на ведение индивидуального инвестиционного счета SESPS от 05.12.2018</p>
    <p>Отчет брокера за период с 27.10.2026<br>по 05.11.2026</p>
    <p>Срочный рынок Торговый код: SESPS</p>
    <table>${row(['CNY-12.26', 'фьючерс', '', '17.12.2026', '0', '', '2', '12.387', vm[0], vm[1]])}</table>
    <p>Срочные сделки</p>
    <table>${row(['29.10.2026', '29.10.2026', '13:40:00', 'CNY-12.26', 'фьючерс', 'Покупка', '2', '12.27', feeBroker, '1.12', '1001', ''])}</table>`;
}

let db: BetterSQLite3Database;
let service: ImportService;
const opts = { format: 'html' as const, systemId: 'sys-1', portfolioId: 'pf-1' };

beforeEach(() => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
  db = drizzle(sqlite);
  db.insert(systems).values([
    { id: 'sys-1', name: 'Тест' },
    { id: 'sys-2', name: 'Другая' },
  ]).run();
  db.insert(portfolios).values({ id: 'pf-1', name: 'ИИС' }).run();
  service = new ImportService(db);
});

describe('ImportService — обновление операций при повторном импорте', () => {
  it('тот же отчёт повторно → 0 изменений', async () => {
    const content = report('3.69');
    await service.commit({ ...opts, content });
    const p = await service.preview({ ...opts, content });
    expect(p.summary).toMatchObject({ update: 0, duplicate: 1, ok: 0 });
    const res = await service.commit({ ...opts, content });
    expect(res).toMatchObject({ imported: 0, updated: 0 });
  });

  it('отчёт с изменённой комиссией → update на 1 строку с диффом, после commit комиссия обновлена', async () => {
    await service.commit({ ...opts, content: report('3.69') }); // 3.69 + 1.12 = 4.81
    const p = await service.preview({ ...opts, content: report('7.40') }); // 7.40 + 1.12 = 8.52
    expect(p.summary).toMatchObject({ update: 1, duplicate: 0 });
    const upd = p.rows.find((r) => r.confidence === 'update');
    expect(upd?.changes).toEqual([{ field: 'fee', from: '4.81', to: '8.52' }]);

    const res = await service.commit({ ...opts, content: report('7.40') });
    expect(res).toMatchObject({ imported: 0, updated: 1 });
    const ops = db.select().from(operations).all();
    expect(ops).toHaveLength(1);
    expect(ops[0].fee).toBe('8.52');
  });

  it('обновление не трогает разметку пользователя: система и заметка остаются', async () => {
    await service.commit({ ...opts, content: report('3.69') });
    db.update(operations).set({ systemId: 'sys-2', note: 'моя заметка' }).run();
    await service.commit({ ...opts, content: report('7.40') });
    const [op] = db.select().from(operations).all();
    expect(op).toMatchObject({ fee: '8.52', systemId: 'sys-2', note: 'моя заметка' });
  });

  it('обновление при уже снятых снимках пишет запись в журнал инвалидаций (не новый механизм)', async () => {
    await service.commit({ ...opts, content: report('3.69') });
    db.insert(portfolioSnapshots)
      .values({ date: '2026-11-06', investedRub: '0', currentValueRub: '0', pnlRub: '0', dividendsRub: '0' })
      .run();
    await service.commit({ ...opts, content: report('7.40') });
    const [entry] = db.select().from(snapshotInvalidations).all();
    expect(entry).toMatchObject({ kind: 'import-commit', operationDate: '2026-10-29', affectedCount: 1 });
    expect(entry.description).toContain('обновлено 1');
  });

  it('та же операция в другом портфеле — не обновление, а дубль (как раньше)', async () => {
    db.insert(portfolios).values({ id: 'pf-2', name: 'Другой счёт' }).run();
    await service.commit({ ...opts, content: report('3.69') });
    const p = await service.preview({ ...opts, portfolioId: 'pf-2', content: report('7.40').replace('SESPS', 'XXXX') });
    expect(p.summary.update).toBe(0);
  });
});

describe('ImportService — комиссия отдельной строкой по ссылке на сделку', () => {
  const trade = (fee = '1'): RawRow => ({
    date: '2026-11-05',
    tradeType: 'Buy',
    ticker: 'SBER',
    instrumentType: 'Stock',
    currency: 'RUB',
    quantity: '10',
    price: '100',
    fee,
    brokerRef: 'T1',
  });
  const feeRow = (amount: string): RawRow => ({
    date: '2026-11-05',
    tradeType: 'Fee',
    quantity: '1',
    price: amount,
    fee: amount,
    brokerRef: 'F1',
    parentBrokerRef: 'T1',
  });

  it('комиссия прибавлена к родителю и не висит отдельной операцией', async () => {
    const uploadId = service.stashRawRows([trade('1'), feeRow('2.5')]);
    const res = await service.commit({ ...opts, uploadId });
    expect(res.imported).toBe(1);
    const ops = db.select().from(operations).all();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ brokerRef: 'T1', fee: '3.5', operationType: 'Buy' });
  });

  it('повторная загрузка тех же строк не удваивает комиссию; изменение суммы — update', async () => {
    await service.commit({ ...opts, uploadId: service.stashRawRows([trade('1'), feeRow('2.5')]) });
    const again = await service.commit({ ...opts, uploadId: service.stashRawRows([trade('1'), feeRow('2.5')]) });
    expect(again).toMatchObject({ imported: 0, updated: 0 });
    expect(db.select().from(operations).all()[0].fee).toBe('3.5');

    const changed = await service.commit({ ...opts, uploadId: service.stashRawRows([trade('1'), feeRow('4')]) });
    expect(changed).toMatchObject({ imported: 0, updated: 1 });
    expect(db.select().from(operations).all()[0].fee).toBe('5');
  });
});

describe('ImportService — вариационная маржа для сверки', () => {
  it('commit сохраняет ВМ в futures_settlements; повторный импорт перезаписывает (upsert)', async () => {
    await service.commit({ ...opts, content: report('3.69', ['204.00', '-11 117.00']) });
    let rows = db.select().from(futuresSettlements).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      portfolioId: 'pf-1',
      instrumentId: 'CNY-12.26',
      date: '2026-11-05',
      periodFrom: '2026-10-27',
      vmPeriod: '204.00',
      vmPlanned: '-11117.00',
      markEnd: '12387',
      source: 'broker-report',
    });

    await service.commit({ ...opts, content: report('3.69', ['300.00', '-11 117.00']) });
    rows = db.select().from(futuresSettlements).where(eq(futuresSettlements.date, '2026-11-05')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].vmPeriod).toBe('300.00');
  });

  it('preview — dry-run: ВМ не сохраняется', async () => {
    await service.preview({ ...opts, content: report('3.69', ['204.00', '-11 117.00']) });
    expect(db.select().from(futuresSettlements).all()).toHaveLength(0);
  });
});
