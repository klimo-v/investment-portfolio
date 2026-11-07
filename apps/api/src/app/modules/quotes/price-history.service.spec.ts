import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { instruments, priceHistory, quotes } from '../../../db/schema';
import { PriceHistoryService } from './price-history.service';
import type { HistoryPoint, HistoryTarget, PriceHistoryProvider } from './price-history.provider';

let db: BetterSQLite3Database;

const point = (date: string, price: string, source: HistoryPoint['source'] = 'moex'): HistoryPoint => ({
  date,
  price,
  currency: 'RUB',
  accruedInterest: null,
  accruedCurrency: null,
  source,
});

/** Провайдер-заглушка: отдаёт ряд из памяти и считает вызовы */
function fakeProvider(series: HistoryPoint[], opts: { fail?: boolean } = {}) {
  const calls: [string, string, string][] = [];
  const provider: PriceHistoryProvider = {
    supports: (t) => t.marketSource === 'moex' || t.kind === 'fx',
    async getHistory(t: HistoryTarget, from: string, till: string) {
      calls.push([t.instrumentId, from, till]);
      if (opts.fail) throw new Error('сеть недоступна');
      return series.filter((p) => p.date >= from && p.date <= till);
    },
  };
  return { provider, calls };
}

const sber: HistoryTarget = { instrumentId: 'SBER', ticker: 'SBER', kind: 'instrument', type: 'Stock', currency: 'RUB', marketSource: 'moex' };
const rows = () => db.select().from(priceHistory).all().sort((a, b) => a.date.localeCompare(b.date));

beforeEach(() => {
  const sqlite = new Database(':memory:');
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
  db = drizzle(sqlite);
  db.insert(instruments).values({ id: 'SBER', ticker: 'SBER', type: 'Stock', currency: 'RUB', marketSource: 'moex' }).run();
});

describe('PriceHistoryService.record: политика приоритетов', () => {
  it('рынок не затирается ручной ценой и снимком; снимок — ручной; свежая рыночная заменяет рыночную', () => {
    const svc = new PriceHistoryService(db, []);
    expect(svc.record('SBER', point('2026-10-01', '300', 'moex'))).toBe(true);
    expect(svc.record('SBER', point('2026-10-01', '1', 'manual'))).toBe(false);
    expect(svc.record('SBER', point('2026-10-01', '2', 'snapshot'))).toBe(false);
    expect(rows()[0].price).toBe('300');

    svc.record('SBER', point('2026-10-02', '10', 'manual'));
    expect(svc.record('SBER', point('2026-10-02', '11', 'snapshot'))).toBe(true);
    expect(svc.record('SBER', point('2026-10-02', '12', 'broker-report'))).toBe(true);
    expect(svc.record('SBER', point('2026-10-02', '13', 'moex'))).toBe(true);
    expect(rows()[1]).toMatchObject({ price: '13', source: 'moex' });

    expect(svc.record('SBER', point('2026-10-02', '14', 'moex'))).toBe(true); // равный приоритет — свежая
    expect(rows()[1].price).toBe('14');
  });
});

describe('PriceHistoryService.ensure: догрузка только недостающего', () => {
  const series = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06'].map((d, i) => point(d, String(100 + i)));

  it('пустая история — один запрос на весь период', async () => {
    const { provider, calls } = fakeProvider(series);
    const svc = new PriceHistoryService(db, [provider]);
    await svc.ensure([sber], '2026-10-01', '2026-10-06');
    expect(calls).toEqual([['SBER', '2026-10-01', '2026-10-06']]);
    expect(rows()).toHaveLength(4);
  });

  it('повторный вызов на тот же период сети не трогает; расширение периода — только хвосты', async () => {
    const { provider, calls } = fakeProvider(series);
    const svc = new PriceHistoryService(db, [provider]);
    await svc.ensure([sber], '2026-10-02', '2026-10-05');
    calls.length = 0;
    await svc.ensure([sber], '2026-10-02', '2026-10-05');
    expect(calls).toEqual([]);

    await svc.ensure([sber], '2026-10-01', '2026-10-06');
    expect(calls).toEqual([
      ['SBER', '2026-10-01', '2026-10-01'],
      ['SBER', '2026-10-06', '2026-10-06'],
    ]);
  });

  it('ручная/снимочная точка не закрывает диапазон: биржевая история всё равно загружается', async () => {
    const svc = new PriceHistoryService(db, [fakeProvider(series).provider]);
    svc.record('SBER', point('2026-10-02', '1', 'manual'));
    const { provider, calls } = fakeProvider(series);
    await new PriceHistoryService(db, [provider]).ensure([sber], '2026-10-01', '2026-10-06');
    expect(calls).toEqual([['SBER', '2026-10-01', '2026-10-06']]);
    expect(rows().find((r) => r.date === '2026-10-02')?.source).toBe('moex');
  });

  it('сбой источника не роняет расчёт и не повторяется сразу; без провайдера — тихо пропускаем', async () => {
    const { provider, calls } = fakeProvider([], { fail: true });
    const svc = new PriceHistoryService(db, [provider]);
    await expect(svc.ensure([sber], '2026-10-01', '2026-10-06')).resolves.toBeUndefined();
    await svc.ensure([sber], '2026-10-01', '2026-10-06');
    expect(calls).toHaveLength(1); // второй вызов — в «отрицательном кэше»

    const manual = { ...sber, instrumentId: 'M', marketSource: 'manual' as const };
    await expect(new PriceHistoryService(db, []).ensure([manual], '2026-10-01', '2026-10-06')).resolves.toBeUndefined();
  });
});

describe('PriceHistoryService.targetsFor: курсы валют', () => {
  it('добавляет fx-цели для нерублёвых валют инструмента, цены и НКД; RUB — нет', () => {
    db.insert(instruments).values({ id: 'BOND', ticker: 'BOND', type: 'Bond', currency: 'RUB', marketSource: 'moex' }).run();
    db.insert(quotes)
      .values({ instrumentId: 'BOND', price: '100', currency: 'USD', accruedInterest: '1', accruedCurrency: 'EUR', source: 'moex', asOf: '2026-11-07T00:00:00.000Z' })
      .run();
    const targets = new PriceHistoryService(db, []).targetsFor(['SBER', 'BOND']);
    expect(targets.map((t) => t.instrumentId).sort()).toEqual(['BOND', 'SBER', 'fx:EUR', 'fx:USD']);
    expect(targets.find((t) => t.instrumentId === 'fx:USD')).toMatchObject({ kind: 'fx', ticker: 'USD', currency: 'RUB' });
  });
});
