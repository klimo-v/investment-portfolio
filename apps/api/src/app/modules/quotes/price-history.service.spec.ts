import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { instruments, priceHistory, quotes } from '../../../db/schema';
import { PriceHistoryService } from './price-history.service';
import type { HistoryPoint, HistoryTarget, PriceHistoryProvider } from './price-history.provider';
import { InstrumentIdentityService } from '../instruments/instrument-identity.service';

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

describe('PriceHistoryService.ensure: диапазон у каждой бумаги свой', () => {
  const series = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06'].map((d, i) => point(d, String(100 + i)));

  it('бумага, которой на старте портфеля не было, не запрашивает заведомо пустое начало', async () => {
    db.insert(instruments).values({ id: 'LATE', ticker: 'LATE', type: 'Stock', currency: 'RUB', marketSource: 'moex' }).run();
    const { provider, calls } = fakeProvider(series);
    const svc = new PriceHistoryService(db, [provider]);
    await svc.ensureForInstruments(new Map([['SBER', '2026-10-01'], ['LATE', '2026-10-05']]), '2026-10-06');
    const forLate = calls.filter((c) => c[0] === 'LATE');
    expect(forLate).toEqual([['LATE', '2026-10-05', '2026-10-06']]);
  });

  it('пустой ответ по «голове» не блокирует загрузку «хвоста» той же бумаги', async () => {
    const { provider, calls } = fakeProvider(series.filter((p) => p.date >= '2026-10-05'));
    const svc = new PriceHistoryService(db, [provider]);
    // первая загрузка покрыла 05–06 октября; теперь просим с 01 октября (голова пуста) и до 08 (хвост)
    await svc.ensure([sber], '2026-10-05', '2026-10-06');
    calls.length = 0;
    await svc.ensure([sber], '2026-10-01', '2026-10-08'); // голова [01..04] — пусто; хвост [07..08] — пусто
    await svc.ensure([sber], '2026-10-01', '2026-10-08');
    expect(calls).toEqual([
      ['SBER', '2026-10-01', '2026-10-04'],
      ['SBER', '2026-10-07', '2026-10-08'],
    ]); // каждый диапазон спрошен один раз: кэш не общий на бумагу, а по диапазону
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

describe('слияние инструментов: история цен переезжает к целевому (одна валюта)', () => {
  it('рынок цели не затирается, недостающие даты и цены слитого сохраняются', async () => {
    const { PortfoliosService } = await import('../portfolios/portfolios.service');
    db.insert(instruments).values({ id: 'OLD', ticker: 'OLD', type: 'Stock', currency: 'RUB', marketSource: 'manual' }).run();
    const svc = new PriceHistoryService(db, []);
    svc.record('SBER', point('2026-10-01', '300', 'moex'));
    svc.record('OLD', point('2026-10-01', '1', 'manual'));
    svc.record('OLD', point('2026-10-02', '2', 'snapshot'));

    new PortfoliosService(db as never, new InstrumentIdentityService(db as never)).mergeInstruments('OLD', 'SBER', { confirmWarnings: true });

    expect(rows().map((r) => [r.instrumentId, r.date, r.price, r.source])).toEqual([
      ['SBER', '2026-10-01', '300', 'moex'],
      ['SBER', '2026-10-02', '2', 'snapshot'],
    ]);
  });
});

describe('цена момента нажатия «Обновить цены» не замораживает день', () => {
  it('точка quote не закрывает диапазон: официальное закрытие того же дня догружается и заменяет её', async () => {
    const svc0 = new PriceHistoryService(db, []);
    svc0.record('SBER', point('2026-10-05', '101', 'moex'));
    svc0.record('SBER', point('2026-10-06', '999', 'quote')); // внутридневная цена в день D
    const official = [point('2026-10-05', '101'), point('2026-10-06', '105')];
    const { provider, calls } = fakeProvider(official);
    await new PriceHistoryService(db, [provider]).ensure([sber], '2026-10-05', '2026-10-06');
    expect(calls).toEqual([['SBER', '2026-10-06', '2026-10-06']]); // покрыто по 05.10, день 06.10 — нет
    expect(rows().find((r) => r.date === '2026-10-06')).toMatchObject({ price: '105', source: 'moex' });
  });

  it('и обратно: котировка не затирает официальное закрытие', () => {
    const svc = new PriceHistoryService(db, []);
    svc.record('SBER', point('2026-10-06', '105', 'moex'));
    expect(svc.record('SBER', point('2026-10-06', '999', 'quote'))).toBe(false);
  });
});

describe('слияние инструментов в разных валютах', () => {
  it('история цен слитого НЕ переносится к целевому (валюта/масштаб цены разные)', async () => {
    const { PortfoliosService } = await import('../portfolios/portfolios.service');
    db.insert(instruments).values({ id: 'USDX', ticker: 'USDX', type: 'Stock', currency: 'USD', marketSource: 'manual' }).run();
    new PriceHistoryService(db, []).record('USDX', point('2026-10-01', '10', 'manual'));
    new PortfoliosService(db as never, new InstrumentIdentityService(db as never)).mergeInstruments('USDX', 'SBER', { confirmWarnings: true });
    expect(rows()).toEqual([]);
  });
});

describe('PriceHistoryService.targetsFor: курсы валют', () => {
  it('валютная пара CNYRUB_TOM (цена в рублях) тянет за собой курс ЦБ юаня fx:CNY', () => {
    db.insert(instruments).values({ id: 'CNYRUB_TOM', ticker: 'CNYRUB_TOM', type: 'Currency', currency: 'RUB', marketSource: 'moex' }).run();
    const targets = new PriceHistoryService(db, []).targetsFor(['CNYRUB_TOM']);
    expect(targets.map((t) => t.instrumentId)).toEqual(['CNYRUB_TOM', 'fx:CNY']);
    expect(targets.find((t) => t.instrumentId === 'fx:CNY')).toMatchObject({ kind: 'fx', marketSource: 'cbr' });
  });

  it('обычный рублёвый инструмент курсов не добавляет', () => {
    expect(new PriceHistoryService(db, []).targetsFor(['SBER']).map((t) => t.instrumentId)).toEqual(['SBER']);
  });
});
