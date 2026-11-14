import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instruments, quotes } from '../../../db/schema';
import { QuotesService } from './quotes.service';
import { MoexProvider } from './moex.provider';
import { BinanceProvider } from './binance.provider';
import { CbrProvider } from './cbr.provider';
import { PriceHistoryService } from './price-history.service';

const oldDate = '2026-01-01T12:00:00.000Z';
describe('Обновление котировок: фактический результат и сохранение предыдущих данных', () => {
  let sqlite: Database.Database;
  let service: QuotesService;
  const moex = vi.fn();
  const binance = vi.fn();
  beforeEach(() => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    db.insert(instruments)
      .values([
        { id: 'a', ticker: 'SBER', type: 'Stock', currency: 'RUB', marketSource: 'moex' },
        { id: 'b', ticker: 'BTC', type: 'Crypto', currency: 'USD', marketSource: 'binance' },
        { id: 'm', ticker: 'MANUAL', type: 'Stock', currency: 'RUB', marketSource: 'manual' },
      ])
      .run();
    db.insert(quotes)
      .values([
        { instrumentId: 'a', price: '90', currency: 'RUB', source: 'moex', asOf: oldDate },
        { instrumentId: 'b', price: '90', currency: 'USD', source: 'binance', asOf: oldDate },
      ])
      .run();
    moex.mockReset();
    binance.mockReset();
    service = new QuotesService(
      db,
      { supports: (s: string) => s === 'moex', getQuote: moex } as unknown as MoexProvider,
      { getRateOrNull: async () => null } as unknown as CbrProvider,
      { supports: (s: string) => s === 'binance', getQuote: binance } as unknown as BinanceProvider,
      { record: vi.fn() } as unknown as PriceHistoryService,
    );
  });
  afterEach(() => {
    sqlite.close();
    vi.unstubAllGlobals();
  });
  const quote = (source: 'moex' | 'binance') => ({
    price: '110',
    currency: 'RUB',
    source,
    asOf: '2026-11-15T12:00:00.000Z',
  });
  it('все автоматические цены получены; ручные не входят в total', async () => {
    moex.mockResolvedValue(quote('moex'));
    binance.mockResolvedValue(quote('binance'));
    expect(await service.refreshAll()).toEqual({
      total: 2,
      updated: 2,
      skippedManual: 1,
      failures: [],
    });
  });
  it('исключение одного источника не прерывает следующий; цена и дата сбоя остаются прежними', async () => {
    moex.mockRejectedValue(new Error('MOEX: HTTP 503'));
    binance.mockResolvedValue(quote('binance'));
    expect(await service.refreshAll()).toEqual({
      total: 2,
      updated: 1,
      skippedManual: 1,
      failures: [{ ticker: 'SBER', source: 'moex', reason: 'MOEX: HTTP 503' }],
    });
    expect(service.list().find((q) => q.instrumentId === 'a')).toMatchObject({
      price: '90',
      asOf: oldDate,
    });
    expect(service.list().find((q) => q.instrumentId === 'b')?.price).toBe('110');
  });
  it('нулевой результат: пустой ответ имеет причину; ни одна старая дата не меняется', async () => {
    const before = service.list();
    moex.mockResolvedValue(null);
    binance.mockResolvedValue(null);
    expect(await service.refreshAll()).toEqual({
      total: 2,
      updated: 0,
      skippedManual: 1,
      failures: [
        { ticker: 'SBER', source: 'moex', reason: 'Источник не вернул цену' },
        { ticker: 'BTC', source: 'binance', reason: 'Источник не вернул цену' },
      ],
    });
    expect(service.list()).toEqual(before);
  });
  it('только ручные инструменты: ввод 100 → 110 переживает refresh и сохраняет дату', async () => {
    sqlite.exec("DELETE FROM quotes; DELETE FROM instruments WHERE market_source != 'manual'");
    service.setManualPrice('m', { price: '100' });
    const saved = service.setManualPrice('m', { price: '110' });
    expect(await service.refreshAll()).toEqual({
      total: 0,
      updated: 0,
      skippedManual: 1,
      failures: [],
    });
    expect(service.list()).toEqual([saved]);
    expect(saved).toMatchObject({ price: '110', currency: 'RUB', source: 'manual' });
    expect(moex).not.toHaveBeenCalled();
    expect(binance).not.toHaveBeenCalled();
  });
  it('автоматический инструмент нельзя редактировать вручную', () => {
    expect(() => service.setManualPrice('a', { price: '110' })).toThrow('автоматический источник');
  });
  it('реальные адаптеры передают известную ошибку HTTP вызывающему сервису', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(new MoexProvider().getQuote('SBER')).rejects.toThrow('MOEX: HTTP 503');
    await expect(new BinanceProvider().getQuote('BTC')).rejects.toThrow('Binance: HTTP 503');
  });
  it('ручная цена фьючерса сохраняется в рублях за контракт', () => {
    sqlite.prepare("UPDATE instruments SET type = 'Future', currency = 'USD' WHERE id = 'm'").run();
    expect(service.setManualPrice('m', {price: '90.123456'})).toMatchObject({currency: 'RUB', price: '90.123456', source: 'manual'});
  });

});
