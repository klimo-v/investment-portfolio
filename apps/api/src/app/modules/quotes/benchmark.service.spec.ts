import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { priceHistory } from '../../../db/schema';
import { BenchmarkController } from './benchmark.controller';
import { BenchmarkService } from './benchmark.service';
import { PriceHistoryService } from './price-history.service';
import type { HistoryPoint, HistoryTarget, PriceHistoryProvider } from './price-history.provider';

let db: BetterSQLite3Database;

const pt = (date: string, price: string): HistoryPoint => ({ date, price, currency: 'IDX', accruedInterest: null, accruedCurrency: null, source: 'moex' });

/** ISS-заглушка: ряд на каждый SECID; считает вызовы */
function fakeIss(data: Record<string, HistoryPoint[]>, opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const provider: PriceHistoryProvider = {
    supports: (t) => t.kind === 'index',
    async getHistory(t: HistoryTarget, from: string, till: string) {
      calls.push(`${t.ticker}|${from}|${till}`);
      if (opts.fail) throw new Error('сеть недоступна');
      return (data[t.ticker] ?? []).filter((p) => p.date >= from && p.date <= till);
    },
  };
  return { provider, calls };
}

beforeEach(() => {
  const sqlite = new Database(':memory:');
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
  db = drizzle(sqlite);
});

const DATA = {
  MCFTRR: [pt('2026-01-02', '200'), pt('2026-01-05', '210'), pt('2026-01-06', '189')],
  RUSFAR: [pt('2026-01-02', '365'), pt('2026-01-05', '365')],
};

describe('BenchmarkService', () => {
  it('индекс и денежный рынок — на базе 100; ряды хранятся в price_history как index:SECID', async () => {
    const { provider } = fakeIss(DATA);
    const svc = new BenchmarkService(new PriceHistoryService(db, [provider]));
    const res = await svc.benchmark('MCFTRR', '2026-01-02', '2026-01-06');
    expect(res.index?.secid).toBe('MCFTRR');
    expect(res.index?.series.map((p) => p.index)).toEqual([100, 100, 100, 105, 94.5]);
    // RUSFAR 365% годовых = 1% в день, ставка действует и в выходные
    expect(res.moneyMarket?.series[1].index).toBeCloseTo(101, 10);
    expect(res.moneyMarket?.series.length).toBe(5);
    expect(new Set(db.select().from(priceHistory).all().map((r) => r.instrumentId))).toEqual(new Set(['index:MCFTRR', 'index:RUSFAR']));
  });

  it('повторные запросы не ходят в источник: пустые «головы» и «хвосты» кэшируются на час (общий механизм догрузки)', async () => {
    const { provider, calls } = fakeIss(DATA);
    const svc = new BenchmarkService(new PriceHistoryService(db, [provider]));
    await svc.benchmark('MCFTRR', '2026-01-02', '2026-01-06');
    // второй запрос один раз проверяет диапазоны вне загруженного (до начала истории, после последней точки)…
    await svc.benchmark('MCFTRR', '2026-01-02', '2026-01-06');
    const settled = calls.length;
    // …третий и далее — ничего
    await svc.benchmark('MCFTRR', '2026-01-02', '2026-01-06');
    expect(calls.length).toBe(settled);
  });

  it('источник недоступен — линии null, расчёт не падает', async () => {
    const { provider } = fakeIss(DATA, { fail: true });
    const svc = new BenchmarkService(new PriceHistoryService(db, [provider]));
    expect(await svc.benchmark('MCFTRR', '2026-01-02', '2026-01-06')).toEqual({ index: null, moneyMarket: null });
  });
});

describe('BenchmarkController: валидация', () => {
  const controller = new BenchmarkController({ benchmark: async () => ({ index: null, moneyMarket: null }) } as unknown as BenchmarkService);

  it('неизвестный SECID, RUSFAR как индекс и кривые даты отклоняются; по умолчанию — MCFTRR', async () => {
    expect(() => controller.get('2026-01-01', '2026-02-01', 'SBER')).toThrow(BadRequestException);
    expect(() => controller.get('2026-01-01', '2026-02-01', 'RUSFAR')).toThrow(BadRequestException);
    expect(() => controller.get('2026-02-01', '2026-01-01', 'IMOEX')).toThrow(BadRequestException);
    expect(() => controller.get('вчера', '2026-01-01', 'IMOEX')).toThrow(BadRequestException);
    await expect(controller.get('2026-01-01', '2026-02-01', undefined as unknown as string)).resolves.toBeDefined();
  });
});
