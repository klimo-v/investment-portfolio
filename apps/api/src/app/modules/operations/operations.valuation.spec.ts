import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardSummarySchema } from '@core';
import { instruments, operations, portfolios, quotes, systems, priceHistory } from '../../../db/schema';
import { QuotesService } from '../quotes/quotes.service';
import type { MoexProvider } from '../quotes/moex.provider';
import type { BinanceProvider } from '../quotes/binance.provider';
import type { PriceHistoryService } from '../quotes/price-history.service';
import { CbrProvider } from '../quotes/cbr.provider';
import { OperationsService } from './operations.service';

describe('Оценка позиций и сделок без курса и частичные итоги', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let service: OperationsService;
  let fx: number | null;
  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    db.insert(systems)
      .values([
        { id: 's1', name: 'Первая' },
        { id: 's2', name: 'Вторая' },
      ])
      .run();
    db.insert(portfolios)
      .values([
        { id: 'p1', name: 'Первый' },
        { id: 'p2', name: 'Второй' },
      ])
      .run();
    db.insert(instruments)
      .values([
        { id: 'USD', ticker: 'USD', type: 'Bond', currency: 'RUB' },
        { id: 'RUB', ticker: 'RUB', type: 'Stock', currency: 'RUB' },
      ])
      .run();
    db.insert(operations)
      .values({
        id: 'buy',
        date: '2026-01-01',
        systemId: 's1',
        portfolioId: 'p1',
        instrumentId: 'USD',
        operationType: 'Buy',
        quantity: '1',
        price: '1000',
        currency: 'RUB',
      })
      .run();
    fx = null;
    // Используем настоящий фасад курсов; сеть заменена только на границе ЦБ.
    const cbr = { getRateOrNull: async (ccy: string) => (ccy === 'RUB' ? 1 : fx) } as CbrProvider;
    const facade = new QuotesService(
      db,
      {} as MoexProvider,
      cbr,
      {} as BinanceProvider,
      {} as PriceHistoryService,
    );
    service = new OperationsService(db, facade);
  });
  afterEach(() => {
    sqlite.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const quoted = (
    db: BetterSQLite3Database,
    currency = 'USD',
    accruedInterest: string | null = null,
    accruedCurrency: string | null = null,
  ) => {
    db.insert(quotes)
      .values({
        instrumentId: 'USD',
        price: '10',
        currency,
        accruedInterest,
        accruedCurrency,
        source: 'manual',
        asOf: '2026-01-01',
      })
      .run();
  };
  it('настоящий ЦБ → фасад → оценка: пустой кеш при сбое и кеш 90 после отключения сети', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const cbr = new CbrProvider();
    service = new OperationsService(
      db,
      new QuotesService(
        db,
        {} as MoexProvider,
        cbr,
        {} as BinanceProvider,
        {} as PriceHistoryService,
      ),
    );
    quoted(db);
    expect((await service.positions())[0].currentValueRub).toBeNull();
    expect((await service.trades())[0].pnlRub).toBeNull();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ Valute: { USD: { Value: 90, Nominal: 1 } } }),
    });
    expect((await service.positions())[0].currentValueRub).toBe('900.00');
    vi.advanceTimersByTime(3600001);
    expect((await service.trades())[0].currentValueRub).toBe('900.00');
    expect((await service.summary()).totals).toMatchObject({
      currentValueRub: 900,
      unvaluedPositionCount: 0,
    });
  });
  it.each([null, 0, -1, NaN, Infinity])(
    'цена USD сохранена, но курс %s не включает оценку или P&L',
    async (rate) => {
      fx = rate;
      quoted(db);
      const [p] = await service.positions();
      expect(p).toMatchObject({
        currentPrice: '10',
        priceCurrency: 'USD',
        currentValueRub: null,
        pnlRub: null,
        valuationIssue: 'Нет курса USD',
      });
      const [t] = await service.trades();
      expect(t).toMatchObject({
        currentPrice: '10',
        priceCurrency: 'USD',
        currentValueRub: null,
        pnlRub: null,
      });
      expect((await service.valuedTrades())[0].currentValueRub).toBeNull();
    },
  );
  it('дневная история имеет дату котировки, а не выдуманное время получения', async () => {
    quoted(db, 'RUB');
    db.insert(priceHistory).values({ instrumentId: 'USD', date: '2026-02-02', price: '12', currency: 'RUB', source: 'moex' }).run();
    expect((await service.positions())[0]).toMatchObject({ currentPrice: '12', priceAsOf: null, quoteDate: '2026-02-02' });
  });
  it('курс 90 оценивает 10 USD в 900 RUB в обеих ветках; RUB не требует курса', async () => {
    quoted(db);
    fx = 90;
    expect((await service.positions())[0]).toMatchObject({
      currentValueRub: '900.00',
      pnlRub: '-100.00',
      valuationIssue: null,
    });
    expect((await service.trades())[0].currentValueRub).toBe('900.00');
    db.update(quotes).set({ currency: 'RUB' }).run();
    fx = null;
    expect((await service.positions())[0].currentValueRub).toBe('10.00');
    expect((await service.trades())[0].currentValueRub).toBe('10.00');
  });
  it('ненулевой НКД в другой валюте требует курса, нулевой — нет', async () => {
    quoted(db, 'RUB', '2', 'EUR');
    expect((await service.positions())[0]).toMatchObject({
      currentPrice: '10',
      currentValueRub: null,
      valuationIssue: 'Нет курса EUR для НКД',
    });
    expect((await service.trades())[0].pnlRub).toBeNull();
    db.update(quotes).set({ accruedInterest: '0' }).run();
    expect((await service.positions())[0]).toMatchObject({
      currentValueRub: '10.00',
      accruedInterestRub: '0.00',
    });
    expect((await service.trades())[0].currentValueRub).toBe('10.00');
    db.update(quotes).set({ accruedInterest: '2' }).run();
    fx = 90;
    expect((await service.positions())[0].currentValueRub).toBe('190.00');
    expect((await service.trades())[0].currentValueRub).toBe('190.00');
  });
  it('закрытая сделка и позиция имеют результат журнала без курса; нулевая оценка известна', async () => {
    db.insert(operations)
      .values({
        id: 'sell',
        date: '2026-01-02',
        systemId: 's1',
        portfolioId: 'p1',
        instrumentId: 'USD',
        operationType: 'Sell',
        quantity: '1',
        price: '1100',
        currency: 'RUB',
      })
      .run();
    expect((await service.trades())[0].pnlRub).toBe('100.00');
    expect((await service.positions())[0].pnlRub).toBe('100.00');
    expect((await service.summary()).totals).toMatchObject({
      unvaluedPositionCount: 0,
      currentValueRub: 0,
      pnlRub: 100,
    });
    db.delete(operations).where(eq(operations.id, 'sell')).run();
    quoted(db, 'RUB');
    db.update(quotes).set({ price: '0' }).run();
    expect((await service.summary()).totals).toMatchObject({
      unvaluedPositionCount: 0,
      currentValueRub: 0,
      pnlRub: -1000,
    });
  });
  it('неизвестная, частичная и полная оценка: весь портфель, счета, системы и фильтры', async () => {
    const initial = await service.summary();
    expect(initial.totals).toMatchObject({
      investedRub: 1000,
      currentValueRub: null,
      pnlRub: null,
      unrealizedPnlRub: null,
      unvaluedPositionCount: 1,
    });
    DashboardSummarySchema.parse(initial);
    db.insert(operations)
      .values({
        id: 'buy2',
        date: '2026-01-01',
        systemId: 's2',
        portfolioId: 'p2',
        instrumentId: 'RUB',
        operationType: 'Buy',
        quantity: '1',
        price: '100',
        currency: 'RUB',
      })
      .run();
    db.insert(quotes)
      .values({
        instrumentId: 'RUB',
        price: '200',
        currency: 'RUB',
        source: 'manual',
        asOf: '2026-01-01',
      })
      .run();
    const partial = await service.summary();
    expect(partial.totals).toMatchObject({
      investedRub: 1100,
      currentValueRub: 200,
      pnlRub: null,
      unvaluedPositionCount: 1,
    });
    expect(partial.byPortfolio.find((p) => p.portfolioId === 'p1')?.unvaluedPositionCount).toBe(1);
    expect(partial.bySystem.find((p) => p.systemId === 's2')?.unvaluedPositionCount).toBe(0);
    expect((await service.summary({ systemId: 's2' })).totals).toMatchObject({
      currentValueRub: 200,
      pnlRub: 100,
      unvaluedPositionCount: 0,
    });
    expect((await service.summary({ portfolioId: 'p1' })).totals.unvaluedPositionCount).toBe(1);
    quoted(db);
    fx = 90;
    expect((await service.summary()).totals).toMatchObject({
      currentValueRub: 1100,
      pnlRub: 0,
      unvaluedPositionCount: 0,
    });
  });
  it('сохраняет точность средней и цены при 10 000 бумаг', async () => {
    db.update(operations).set({ quantity: '10000', price: '2.134567' }).run();
    quoted(db, 'RUB');
    db.update(quotes).set({ price: '2.134567' }).run();
    expect((await service.positions())[0]).toMatchObject({
      avgBuyPrice: '2.134567', currentPrice: '2.134567', currentValueRub: '21345.67',
    });
    db.update(operations).set({ price: '0.00001234' }).run();
    expect((await service.positions())[0].avgBuyPrice).toBe('0.00001234');
  });
  it('передаёт состав +100 −30 +10 = +80 и ноль для закрытой позиции', async () => {
    db.update(operations).set({ quantity: '2', price: '100' }).run();
    db.insert(operations).values([
      { id: 'sell-part', date: '2026-01-02', systemId: 's1', portfolioId: 'p1', instrumentId: 'USD', operationType: 'Sell', quantity: '1', price: '200', currency: 'RUB' },
      { id: 'payout', date: '2026-01-03', systemId: 's1', portfolioId: 'p1', instrumentId: 'USD', operationType: 'Dividend', quantity: '1', price: '10', currency: 'RUB' },
    ]).run();
    quoted(db, 'RUB');
    db.update(quotes).set({ price: '70' }).run();
    expect((await service.positions())[0]).toMatchObject({realizedPnlRub: '100.00', unrealizedPnlRub: '-30.00', dividendsRub: '10.00', pnlRub: '80.00'});
    db.delete(quotes).run();
    expect((await service.positions())[0]).toMatchObject({realizedPnlRub: '100.00', unrealizedPnlRub: null, dividendsRub: '10.00', pnlRub: null});
    db.insert(operations).values({ id: 'close', date: '2026-01-04', systemId: 's1', portfolioId: 'p1', instrumentId: 'USD', operationType: 'Sell', quantity: '1', price: '100', currency: 'RUB' }).run();
    expect((await service.positions())[0]).toMatchObject({unrealizedPnlRub: '0.00', pnlRub: '110.00'});
  });
  it('состав P&L короткого фьючерса сохраняет знак', async () => {
    db.update(instruments).set({ type: 'Future' }).where(eq(instruments.id, 'USD')).run();
    db.update(operations).set({ operationType: 'Sell', quantity: '2', price: '100' }).run();
    quoted(db, 'RUB');
    db.update(quotes).set({ price: '90' }).run();
    expect((await service.positions())[0]).toMatchObject({quantity: '-2', unrealizedPnlRub: '20.00', pnlRub: '20.00'});
  });
  it.each(['manual', 'broker-report'] as const)('цена отчёта: старый и новый источник %s', async (source) => {
    quoted(db, 'RUB');
    db.update(quotes).set({source, asOf: '2026-01-01T00:00:00.000Z'}).run();
    db.insert(priceHistory).values({instrumentId: 'USD', date: '2026-01-01', price: '10', currency: 'RUB', source: 'broker-report'}).run();
    expect((await service.positions())[0]).toMatchObject({priceSource: 'broker-report', quoteDate: '2026-01-01', priceAsOf: null});
    db.update(quotes).set({source: 'manual', asOf: '2026-01-01T12:34:00.000Z'}).run();
    expect((await service.positions())[0]).toMatchObject({priceSource: 'manual', quoteDate: null, priceAsOf: '2026-01-01T12:34:00.000Z'});
  });

});
