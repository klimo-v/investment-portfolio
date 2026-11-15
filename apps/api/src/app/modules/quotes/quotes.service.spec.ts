import Database from 'better-sqlite3';
import { BadRequestException } from '@nestjs/common';
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
  let history: PriceHistoryService;
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
    history = new PriceHistoryService(db, []);
    service = new QuotesService(
      db,
      { supports: (s: string) => s === 'moex', getQuote: moex } as unknown as MoexProvider,
      { getRateOrNull: async () => null } as unknown as CbrProvider,
      { supports: (s: string) => s === 'binance', getQuote: binance } as unknown as BinanceProvider,
      history,
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
    expect(service.setManualPrice('m', { price: '90.123456' })).toMatchObject({
      currency: 'RUB',
      price: '90.123456',
      source: 'manual',
    });
  });

  it.each(['broken-price', '', ' ', 'NaN', 'Infinity', '-Infinity'])(
    'невалидная цена %s: прежняя котировка и история сохраняются',
    async (price) => {
      sqlite.exec(
        "UPDATE quotes SET accrued_interest='2', accrued_currency='RUB' WHERE instrument_id='a'",
      );
      history.record('a', {
        date: '2026-01-01',
        price: '90',
        currency: 'RUB',
        accruedInterest: '2',
        accruedCurrency: 'RUB',
        source: 'moex',
      });
      const before = service.list().find((q) => q.instrumentId === 'a');
      const previous = history.list(['a']);
      moex.mockResolvedValue({ ...quote('moex'), price });
      binance.mockResolvedValue(quote('binance'));
      expect(await service.refreshAll()).toMatchObject({
        updated: 1,
        total: 2,
        failures: [{ ticker: 'SBER', source: 'moex', reason: 'Некорректная цена' }],
      });
      expect(service.list().find((q) => q.instrumentId === 'a')).toEqual(before);
      expect(history.list(['a'])).toEqual(previous);
    },
  );
  it.each(['broken', '', 'NaN', 'Infinity'])(
    'невалидный НКД %s отклоняется до первой записи',
    async (accruedInterest) => {
      const before = service.list();
      moex.mockResolvedValue({ ...quote('moex'), accruedInterest });
      binance.mockResolvedValue(null);
      expect((await service.refreshAll()).failures[0].reason).toBe('Некорректный НКД');
      expect(service.list()).toEqual(before);
      expect(history.list(['a'])).toEqual([]);
    },
  );
  it('сохраняет точность, нулевой НКД и приоритет истории', async () => {
    history.record('a', {
      date: '2026-11-15',
      price: '99',
      currency: 'RUB',
      accruedInterest: null,
      accruedCurrency: null,
      source: 'moex',
    });
    moex.mockResolvedValue({
      ...quote('moex'),
      price: '0.0000123456789123456789',
      accruedInterest: '0',
    });
    binance.mockResolvedValue(null);
    await service.refreshAll();
    expect(service.list().find((q) => q.instrumentId === 'a')).toMatchObject({
      price: '0.0000123456789123456789',
      accruedInterest: '0',
    });
    expect(history.list(['a'])[0].price).toBe('99');
  });
  it('поиск пропускает некорректную первую площадку, принимает вторую', async () => {
    service.setManualPrice('m', { price: '100' });
    moex.mockResolvedValue({ ...quote('moex'), price: 'broken' });
    binance.mockResolvedValue({ ...quote('binance'), price: '120.123456789' });
    expect(await service.resolveViaApi('m')).toEqual({ price: '120.123456789', source: 'binance' });
    expect(sqlite.prepare("SELECT market_source FROM instruments WHERE id='m'").get()).toEqual({
      market_source: 'binance',
    });
  });
  it('неудачный поиск и ошибка истории не меняют ручную цену и источник', async () => {
    service.setManualPrice('m', { price: '100' });
    const before = service.list();
    const previous = history.list(['m']);
    moex.mockResolvedValue({ ...quote('moex'), price: 'broken' });
    binance.mockResolvedValue(null);
    await expect(service.resolveViaApi('m')).rejects.toThrow('Не нашлось');
    expect(service.list()).toEqual(before);
    moex.mockResolvedValue({ ...quote('moex'), price: '120' });
    binance.mockClear();
    binance.mockResolvedValue({ ...quote('binance'), price: '5' });
    const record = history.record.bind(history);
    vi.spyOn(history, 'record').mockImplementation((...args) => {
      record(...args);
      throw new Error('write failure');
    });
    await expect(service.resolveViaApi('m')).rejects.toThrow(
      'найдена (moex), но сохранить её не удалось',
    );
    expect(binance).not.toHaveBeenCalled();
    expect(service.list()).toEqual(before);
    expect(history.list(['m'])).toEqual(previous);
    expect(sqlite.prepare("SELECT market_source FROM instruments WHERE id='m'").get()).toEqual({
      market_source: 'manual',
    });
  });
  it('отрицательная ручная акция: HTTP 400 без изменения цены, даты и истории', () => {
    service.setManualPrice('m', { price: '100' });
    const before = service.list();
    const previous = history.list(['m']);
    try {
      service.setManualPrice('m', { price: '-4' });
      expect.fail('Ожидалась ошибка HTTP 400');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getStatus()).toBe(400);
      expect((error as Error).message).toBe('Некорректная цена');
    }
    expect(service.list()).toEqual(before);
    expect(history.list(['m'])).toEqual(previous);
    expect(service.setManualPrice('m', { price: '0' }).price).toBe('0');
    sqlite.exec("UPDATE instruments SET type='Future' WHERE id='m'");
    expect(service.setManualPrice('m', { price: '-4' }).price).toBe('-4');
  });
  it('новая и ранее сохранённая экспонента выдаются точной десятичной строкой', async () => {
    moex.mockResolvedValue({ ...quote('moex'), price: '1e-12' });
    binance.mockResolvedValue(quote('binance'));
    expect((await service.refreshAll()).updated).toBe(2);
    expect(service.list().find((q) => q.instrumentId === 'a')?.price).toBe('0.000000000001');
    expect(history.list(['a'])[0].price).toBe('0.000000000001');
    sqlite.exec("UPDATE quotes SET price='1e-12' WHERE instrument_id='a'");
    expect(service.list().find((q) => q.instrumentId === 'a')?.price).toBe('0.000000000001');
  });
});
