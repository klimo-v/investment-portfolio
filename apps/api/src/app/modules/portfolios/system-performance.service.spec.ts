import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { SystemPerformanceQuerySchema } from '@core';
import { futuresSettlements, instruments, operations, portfolios, quotes, systems } from '../../../db/schema';
import { OperationsService } from '../operations/operations.service';
import { PriceHistoryService } from '../quotes/price-history.service';
import { ValuationService } from '../valuation/valuation.service';
import type { QuotesService } from '../quotes/quotes.service';
import { SystemPerformanceService } from './system-performance.service';

/**
 * Статистика системы на эталоне отчёта SESPS (CNY-12.26): те же 14 сделок, что и в
 * operations.futures.spec.ts. Проверяем сборку: фильтры, оценку открытой сделки по
 * расчётной цене 12 387, 404 и пустую систему. Математика метрик — в core/performance.spec.ts.
 */
const quotesStub = { getFxRate: async () => 1, getFxRateOrNull: async () => 1 } as unknown as QuotesService;

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

describe('SystemPerformanceService', () => {
  let db: BetterSQLite3Database;
  let service: SystemPerformanceService;
  let ops: OperationsService;

  beforeEach(() => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
    db = drizzle(sqlite);
    db.insert(systems).values([
      { id: 'sys', name: 'ЮВ1' },
      { id: 'empty', name: 'Пустая' },
    ]).run();
    db.insert(portfolios).values([
      { id: 'pf', name: 'ИИС' },
      { id: 'pf2', name: 'Другой счёт' },
    ]).run();
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
    ops = new OperationsService(db, quotesStub);
    service = new SystemPerformanceService(
      db,
      ops,
      new ValuationService(db, ops, new PriceHistoryService(db, []), quotesStub),
    );
  });

  it('эталон: net закрытых −15 852,46, комиссии 962,91, нереализованный +4 288, сверка с ВМ −10 913', async () => {
    const p = await service.performance('sys', {});
    expect(p).toMatchObject({ systemId: 'sys', systemName: 'ЮВ1' });
    expect(p.summary).toMatchObject({
      netPnlRub: '-15852.46',
      feesTotalRub: '962.91',
      openRealizedRub: '-311.45',
      unrealizedRub: '4288.00',
      openCount: 1,
    });
    // валовый результат по ценам сделок + нереализованный = вариационная маржа отчёта
    const gross = Number(p.summary.netPnlRub) + Number(p.summary.openRealizedRub) + Number(p.summary.feesTotalRub) + Number(p.summary.unrealizedRub);
    expect(gross).toBeCloseTo(-10913, 6);
    expect(p.tradeMetrics.trades).toMatchObject({ closed: 2, winRatePct: 50 });
  });

  it('инвариант: последняя точка кривой «Результат системы» = «Всего» (котировка 12 387 подставлена на сегодня)', async () => {
    const p = await service.performance('sys', {});
    const last = p.series.result[p.series.result.length - 1];
    expect(p.series.result[0].date).toBe('2026-10-29');
    expect(last.totalRub).toBe(p.summary.totalRub);
    expect(last.totalRub).toBe('-11875.91');
    expect(last.unrealizedRub).toBe(p.summary.unrealizedRub);
    expect(p.equityMetrics.basis).toBeTruthy();
  });

  it('без котировки последняя точка кривой совпадает с «Всего» (оценки нет: переоценка 0)', async () => {
    db.delete(quotes).run();
    const p = await service.performance('sys', {});
    const last = p.series.result[p.series.result.length - 1];
    expect(last.totalRub).toBe(p.summary.totalRub);
    expect(last.carried).toEqual([{ instrumentId: 'CNY-12.26', reason: 'no-price', priceDate: null }]);
  });

  it('без расчётной цены нереализованный = 0, остальное считается', async () => {
    db.delete(quotes).run();
    const p = await service.performance('sys', {});
    expect(p.summary.unrealizedRub).toBe('0.00');
    expect(p.summary.netPnlRub).toBe('-15852.46');
  });

  it('фильтр портфеля: чужой портфель даёт пустую статистику', async () => {
    const p = await service.performance('sys', { portfolioId: 'pf2' });
    expect(p.tradeMetrics.trades.closed).toBe(0);
    expect(p.series.equity).toEqual([]);
  });

  it('фильтр периода: from=05.11 оставляет только сделку, закрытую 05.11 (и открытую)', async () => {
    const p = await service.performance('sys', { from: '2026-11-05' });
    expect(p.tradeMetrics.trades.closed).toBe(1);
    expect(p.summary.netPnlRub).toBe('-16037.16');
    expect(p.summary.openCount).toBe(1);
  });

  it('till=30.10: видна только первая сделка, шортов ещё нет', async () => {
    const p = await service.performance('sys', { till: '2026-10-30' });
    expect(p.tradeMetrics.trades.closed).toBe(1);
    expect(p.summary.netPnlRub).toBe('184.70');
    expect(p.summary.openCount).toBe(0);
  });

  it('till в прошлом: открытые сделки без оценки по сегодняшней цене', async () => {
    const p = await service.performance('sys', { till: '2026-11-04' });
    expect(p.summary.openCount).toBe(1); // шорт открыт 04.11
    expect(p.summary.unrealizedRub).toBe('0.00');
  });

  it('пустая система — валидный DTO с нулями', async () => {
    const p = await service.performance('empty', {});
    expect(p.systemName).toBe('Пустая');
    expect(p.summary.totalRub).toBe('0.00');
    expect(p.series.byMonth).toEqual([]);
  });

  it('несуществующая система — 404', async () => {
    await expect(service.performance('nope', {})).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('сверка с вариационной маржой брокера', () => {
    const settle = () =>
      db.insert(futuresSettlements)
        .values({
          portfolioId: 'pf',
          instrumentId: 'CNY-12.26',
          date: '2026-11-05',
          periodFrom: '2026-10-27',
          vmPeriod: '204.00',
          vmPlanned: '-11117.00',
          qtyStart: '0',
          markStart: null,
          markEnd: '12387',
        })
        .run();

    it('эталон: расхождение 0 — на странице системы и у позиции в портфеле', async () => {
      settle();
      const p = await service.performance('sys', {});
      expect(p.reconciliation).toHaveLength(1);
      expect(p.reconciliation[0]).toMatchObject({
        ticker: 'CNY-12.26',
        portfolioId: 'pf',
        status: 'ok',
        diffRub: '0.00',
        brokerRub: '-10913.00',
        asOf: '2026-11-05',
      });
      const [pos] = await ops.positions();
      expect(pos.settlementCheck).toMatchObject({ status: 'ok', diffRub: '0.00' });
    });

    it('потерянная сделка → mismatch с суммой расхождения', async () => {
      settle();
      db.delete(operations).where(eq(operations.brokerRef, '1008')).run();
      const p = await service.performance('sys', {});
      expect(p.reconciliation[0].status).toBe('mismatch');
      expect(Math.abs(Number(p.reconciliation[0].diffRub))).toBeGreaterThan(1);
    });

    it('контракт делят две системы — на странице системы сверки нет, у позиции портфеля есть', async () => {
      settle();
      db.update(operations).set({ systemId: 'empty' }).where(eq(operations.brokerRef, '1001')).run();
      const p = await service.performance('sys', {});
      expect(p.reconciliation).toEqual([]);
      const positions = await ops.positions();
      expect(positions.every((x) => x.settlementCheck?.status === 'ok')).toBe(true);
    });

    it('отчёт не импортировался — сверки нет (null / пусто)', async () => {
      const p = await service.performance('sys', {});
      expect(p.reconciliation).toEqual([]);
      const [pos] = await ops.positions();
      expect(pos.settlementCheck).toBeNull();
    });
  });

  it('валидация query: некорректная дата и from > till отклоняются', () => {
    expect(SystemPerformanceQuerySchema.safeParse({ from: '05.11.2026' }).success).toBe(false);
    expect(SystemPerformanceQuerySchema.safeParse({ from: '2026-11-05', till: '2026-11-01' }).success).toBe(false);
    expect(SystemPerformanceQuerySchema.safeParse({ portfolioId: 'pf', from: '2026-11-01' }).success).toBe(true);
  });
});
