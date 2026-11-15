import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PerformanceQuerySchema, type CouponScheduleRow } from '@core';
import { instruments, operations, portfolios, priceHistory, systems } from '../../../db/schema';
import { OperationsService } from '../operations/operations.service';
import { PriceHistoryService } from '../quotes/price-history.service';
import type { QuotesService } from '../quotes/quotes.service';
import type { CouponScheduleService } from '../quotes/coupon-schedule.service';
import { PerformanceService } from './performance.service';
import { ValuationService } from './valuation.service';

const quotesStub = {
  getFxRate: async () => 1,
  getFxRateOrNull: async () => 1,
} as unknown as QuotesService;
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

let db: BetterSQLite3Database;
let service: PerformanceService;
let ops: OperationsService;
let valuation: ValuationService;
let makeService: (
  valuation: ValuationService,
  ops: OperationsService,
  schedule: CouponScheduleRow[],
) => PerformanceService;

function op(o: {
  date: string;
  type: typeof operations.$inferInsert.operationType;
  system?: string;
  portfolio?: string;
  instrument?: string | null;
  qty?: string;
  price?: string;
}) {
  db.insert(operations)
    .values({
      id: randomUUID(),
      date: o.date,
      systemId: o.system ?? 's1',
      portfolioId: o.portfolio ?? 'p1',
      instrumentId: o.instrument === undefined ? 'SBER' : o.instrument,
      operationType: o.type,
      quantity: o.qty ?? '1',
      price: o.price ?? '0',
      currency: 'RUB',
    })
    .run();
}

beforeEach(() => {
  makeService = (valuation, ops, schedule) =>
    new PerformanceService(db, valuation, ops, {
      ensure: async () => undefined,
      list: () => schedule,
    } as unknown as CouponScheduleService);
  const sqlite = new Database(':memory:');
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
  db = drizzle(sqlite);
  db.insert(systems)
    .values([
      { id: 's1', name: 'Ядро' },
      { id: 's2', name: 'Тактика' },
    ])
    .run();
  db.insert(portfolios)
    .values([
      { id: 'p1', name: 'Счёт 1' },
      { id: 'p2', name: 'Счёт 2' },
    ])
    .run();
  db.insert(instruments)
    .values([
      { id: 'SBER', ticker: 'SBER', type: 'Stock', currency: 'RUB', marketSource: 'manual' },
      { id: 'GAZP', ticker: 'GAZP', type: 'Stock', currency: 'RUB', marketSource: 'manual' },
    ])
    .run();
  // счёт 1 / система «Ядро»: ввод 100 000, покупка SBER; счёт 2 / «Тактика»: ввод 50 000, покупка GAZP
  op({ date: day(-30), type: 'Deposit', instrument: null, price: '100000' });
  op({ date: day(-29), type: 'Buy', qty: '100', price: '100' });
  op({
    date: day(-30),
    type: 'Deposit',
    instrument: null,
    price: '50000',
    system: 's2',
    portfolio: 'p2',
  });
  op({
    date: day(-29),
    type: 'Buy',
    instrument: 'GAZP',
    qty: '50',
    price: '200',
    system: 's2',
    portfolio: 'p2',
  });
  op({ date: day(-10), type: 'Dividend', qty: '1', price: '500' });
  const px = (id: string, date: string, price: string) =>
    db
      .insert(priceHistory)
      .values({ instrumentId: id, date, price, currency: 'RUB', source: 'moex' })
      .run();
  px('SBER', day(-29), '100');
  px('SBER', day(-5), '110');
  px('GAZP', day(-29), '200');
  px('GAZP', day(-5), '190');
  ops = new OperationsService(db, quotesStub);
  valuation = new ValuationService(db, ops, new PriceHistoryService(db, []), quotesStub);
  service = makeService(valuation, ops, []);
});

describe('PerformanceService: единый DTO периода', () => {
  it('«Всё время»: результат = переоценка + выплаты; TWR карточки = последняя точка ряда индекса', async () => {
    const dto = await service.performance({ scope: 'all' });
    // SBER +10×100 = +1 000, GAZP −10×50 = −500, дивиденд +500
    expect(dto.total.resultRub).toBe('1000.00');
    expect(dto.total.breakdown.payoutsRub).toBe('500.00');
    const series = dto.total.twr.series;
    expect(series[series.length - 1].index - 100).toBeCloseTo(dto.total.twr.pct as number, 10);
    expect(dto.total.contour).toBe('wealth');
  });

  it('сумма результатов по системам и по портфелям = результат всего журнала', async () => {
    const dto = await service.performance({ scope: 'all' });
    const sum = (rows: { performance: { resultRub: string } }[]) =>
      rows.reduce((s, r) => s.plus(r.performance.resultRub), new Decimal(0)).toFixed(2);
    expect(dto.bySystem.map((r) => r.name)).toEqual(['Ядро', 'Тактика']);
    expect(dto.byPortfolio.map((r) => r.name)).toEqual(['Счёт 1', 'Счёт 2']);
    expect(sum(dto.bySystem)).toBe(dto.total.resultRub);
    expect(sum(dto.byPortfolio)).toBe(dto.total.resultRub);
  });

  it('период внутри истории: база по рынку на день до from, а не по себестоимости', async () => {
    const dto = await service.performance({ scope: 'all', from: day(-6) });
    expect(dto.total.baseDate).toBe(day(-7));
    // на базе (day-7) SBER стоит 10 000, GAZP 10 000, кэш: 150 000 − 10 000 − 10 000 + 500 → V = 150 500
    expect(dto.total.startValueRub).toBe('150500.00');
    // за период: SBER +1 000, GAZP −500
    expect(dto.total.resultRub).toBe('500.00');
  });

  it('scope=system — контур позиций; scope=portfolio — свой кэш (wealth)', async () => {
    const sys = await service.performance({ scope: 'system', id: 's1' });
    expect(sys.total.contour).toBe('positions');
    expect(sys.bySystem.map((r) => r.id)).toEqual(['s1']);
    const pf = await service.performance({ scope: 'portfolio', id: 'p2' });
    expect(pf.total.contour).toBe('wealth');
    expect(pf.total.resultRub).toBe('-500.00');
  });

  it('валидация запроса: scope без id и перевёрнутый период отклоняются', () => {
    expect(PerformanceQuerySchema.safeParse({ scope: 'system' }).success).toBe(false);
    expect(
      PerformanceQuerySchema.safeParse({ scope: 'all', from: '2026-02-01', till: '2026-01-01' })
        .success,
    ).toBe(false);
    expect(PerformanceQuerySchema.safeParse({}).success).toBe(true);
  });
});

describe('PerformanceService: предупреждения о полноте журнала', () => {
  it('без графика купонов и с покрытым кэшем предупреждений нет', async () => {
    expect((await service.performance({ scope: 'all' })).warnings).toEqual([]);
  });

  it('пропущенный купон из графика биржи попадает в warnings и помечает период', async () => {
    db.insert(instruments)
      .values({ id: 'OFZ', ticker: 'SU-TEST', type: 'Bond', currency: 'RUB', marketSource: 'moex' })
      .run();
    op({ date: day(-29), type: 'Buy', instrument: 'OFZ', qty: '10', price: '100' });
    db.insert(priceHistory)
      .values({
        instrumentId: 'OFZ',
        date: day(-29),
        price: '100',
        currency: 'RUB',
        source: 'moex',
      })
      .run();
    const coupon = {
      instrumentId: 'OFZ',
      couponDate: day(-20),
      recordDate: day(-21),
      amountRub: '30',
    };
    const withSchedule = makeService(valuation, ops, [coupon]);
    const dto = await withSchedule.performance({ scope: 'all', from: day(-25) });
    expect(dto.warnings).toHaveLength(1);
    expect(dto.warnings[0]).toMatchObject({
      kind: 'missing-coupon',
      ticker: 'SU-TEST',
      date: day(-20),
      amountRub: '300.00',
      inPeriod: true,
    });
    // период после предупреждения его не задевает
    expect(
      (await withSchedule.performance({ scope: 'all', from: day(-10) })).warnings[0].inPeriod,
    ).toBe(false);
    // купон внесён — предупреждения нет
    op({ date: day(-19), type: 'Coupon', instrument: 'OFZ', qty: '1', price: '300' });
    expect((await withSchedule.performance({ scope: 'all' })).warnings).toEqual([]);
  });

  it('отрицательный кэш у контура со своим кэшем даёт предупреждение; у системы — нет', async () => {
    op({ date: day(-5), type: 'Buy', qty: '1000', price: '100' }); // покупка на 100 000 при вводе 100 000 + 50 000 на других счетах
    const all = await service.performance({ scope: 'all' });
    // на счёте 1: ввод 100 000 − покупки (100×100 + 1000×100) < 0
    const pf = await service.performance({ scope: 'portfolio', id: 'p1' });
    expect(pf.warnings.some((w) => w.kind === 'negative-cash')).toBe(true);
    expect(
      all.warnings.every((w) => w.kind === 'negative-cash' || w.kind === 'missing-coupon'),
    ).toBe(true);
    const sys = await service.performance({ scope: 'system', id: 's1' });
    expect(sys.warnings.some((w) => w.kind === 'negative-cash')).toBe(false);
  });
});

describe('PerformanceService: один вход на все ряды, тикер в пометках, просадка в DTO', () => {
  it('догрузка истории цен и подготовка входа выполняются один раз на запрос, а не на каждый ряд', async () => {
    const spy = vi.spyOn(PriceHistoryService.prototype, 'ensureForInstruments');
    await service.performance({ scope: 'all' }); // 2 системы + 2 портфеля + итог = 6 рядов
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('просадка ряда TWR приходит в DTO (≤ 0) и совпадает с расчётом по ряду', async () => {
    const dto = await service.performance({ scope: 'all' });
    expect(dto.total.maxDrawdownPct).not.toBeNull();
    expect(dto.total.maxDrawdownPct as number).toBeLessThanOrEqual(0);
  });

  it('пометка «цена не найдена» несёт тикер, а не внутренний id инструмента', async () => {
    db.insert(instruments)
      .values({
        id: 'a3f-uuid',
        ticker: 'NOPRICE',
        type: 'Stock',
        currency: 'RUB',
        marketSource: 'manual',
      })
      .run();
    op({ date: day(-3), type: 'Buy', instrument: 'a3f-uuid', qty: '1', price: '100' });
    const dto = await service.performance({ scope: 'all' });
    const c = dto.carried.find((x) => x.instrumentId === 'a3f-uuid');
    expect(c?.ticker).toBe('NOPRICE');
  });
});

describe('Качество на базе и на всём интервале доходности', () => {
  it.each(['base', 'middle', 'outside', 'other'] as const)('проблема только %s', async (where) => {
    db.delete(operations).run();
    db.delete(priceHistory).run();
    const start = '2026-01-02',
      till = '2026-01-04';
    op({ date: '2026-01-01', type: 'Buy', qty: '10', price: '100' });
    const px = (date: string, price = '120', id = 'SBER') =>
      db
        .insert(priceHistory)
        .values({ instrumentId: id, date, price, currency: 'RUB', source: 'manual' })
        .run();
    if (where === 'base') {
      px(start);
      px('2026-01-03');
      px(till);
    } else {
      px('2026-01-01', '100');
      px(start);
      px('2026-01-03');
      px(till);
    }
    if (where === 'other') {
      op({
        date: '2026-01-01',
        type: 'Buy',
        system: 's2',
        portfolio: 'p2',
        instrument: 'GAZP',
        qty: '1',
        price: '100',
      });
    }
    // В середине: источник цены временно меняется на валюту без курса, затем восстанавливается.
    if (where === 'middle')
      db.update(priceHistory)
        .set({ currency: 'USD' })
        .where(eq(priceHistory.date, '2026-01-03'))
        .run();
    // Ошибка до фактической базы: купили раньше, а цена появилась за день до from.
    if (where === 'outside') db.update(operations).set({ date: '2025-12-30' }).run();
    const result = await service.performance({ scope: 'system', id: 's1', from: start, till });
    expect(result.total.baseDate).toBe('2026-01-01');
    expect(result.carried.length > 0).toBe(where === 'base' || where === 'middle');
    expect((result.bySystem.find((r) => r.id === 's1')?.performance.quality.length ?? 0) > 0).toBe(
      where === 'base' || where === 'middle',
    );
    if (where === 'base') {
      expect(result.total.twr.pct).toBeCloseTo(20, 8);
      expect(result.carried[0]).toMatchObject({
        ticker: 'SBER',
        reason: 'no-price',
        dates: ['2026-01-01'],
      });
    }
    if (where === 'other') {
      const all = await service.performance({ scope: 'all', from: start, till });
      expect(all.bySystem.find((r) => r.id === 's1')?.performance.quality).toEqual([]);
      expect(all.bySystem.find((r) => r.id === 's2')?.performance.quality.length).toBeGreaterThan(
        0,
      );
      const account = await service.performance({
        scope: 'portfolio',
        id: 'p1',
        from: start,
        till,
      });
      expect(account.carried).toEqual([]);
    }
    if (where === 'middle')
      expect(result.carried[0]).toMatchObject({ reason: 'no-fx', dates: ['2026-01-03'] });
  });
});

describe('P2: разбивка результата периода по инструментам', () => {
  const reset = () => {
    db.delete(operations).run();
    db.delete(priceHistory).run();
  };
  const px = (instrumentId: string, date: string, price: string) =>
    db
      .insert(priceHistory)
      .values({ instrumentId, date, price, currency: 'RUB', source: 'manual' })
      .run();
  const sum = (dto: Awaited<ReturnType<PerformanceService['performance']>>) =>
    dto.byInstrument.reduce((s, r) => s.plus(r.resultRub), new Decimal(0)).toFixed(2);

  it('старые +200 не попадают в тихий период: карточка, система и инструмент = 0; подготовка одна', async () => {
    reset();
    op({ date: '2026-01-01', type: 'Buy', qty: '10', price: '100' });
    px('SBER', '2026-01-01', '100');
    px('SBER', '2026-01-02', '120');
    const prepare = vi.spyOn(valuation, 'prepare');
    const dto = await service.performance({
      scope: 'system',
      id: 's1',
      from: '2026-01-03',
      till: '2026-01-04',
    });
    expect(dto.total.resultRub).toBe('0.00');
    expect(dto.bySystem[0].performance.resultRub).toBe('0.00');
    expect(dto.byInstrument[0].resultRub).toBe('0.00');
    expect(prepare).toHaveBeenCalledTimes(1);
    const carried = await service.performance({
      scope: 'system',
      id: 's1',
      from: '2026-01-05',
      till: '2026-01-06',
    });
    expect(carried.byInstrument[0].quality.length).toBeGreaterThan(0);
  });

  it('закрытие, купон, дивиденд, расходы без инструмента, одинаковая бумага на двух счетах и оба фильтра', async () => {
    reset();
    op({ date: '2026-01-01', type: 'Buy', qty: '10', price: '100' });
    op({ date: '2026-01-01', type: 'Buy', qty: '10', price: '100', portfolio: 'p2' });
    px('SBER', '2026-01-01', '120');
    op({ date: '2026-01-03', type: 'Sell', qty: '10', price: '130' });
    op({ date: '2026-01-03', type: 'Sell', qty: '10', price: '140', portfolio: 'p2' });
    op({ date: '2026-01-03', type: 'Coupon', price: '20' });
    op({ date: '2026-01-04', type: 'Dividend', price: '30' });
    op({ date: '2026-01-04', type: 'Fee', instrument: null, price: '7' });
    const dto = await service.performance({
      scope: 'system',
      id: 's1',
      portfolioId: 'p1',
      from: '2026-01-03',
      till: '2026-01-04',
    });
    expect(dto.byInstrument.map((r) => [r.name, r.resultRub])).toEqual([
      ['SBER', '150.00'],
      ['Без инструмента', '-7.00'],
    ]);
    expect(dto.total.resultRub).toBe('143.00');
    expect(sum(dto)).toBe('143.00');
    const both = await service.performance({
      scope: 'all',
      from: '2026-01-03',
      till: '2026-01-04',
    });
    expect(both.total.resultRub).toBe('343.00');
    expect(sum(both)).toBe('343.00');
    const first = await service.performance({
      scope: 'all',
      from: '2026-01-01',
      till: '2026-01-04',
    });
    expect(first.total.baseDate).toBeNull();
    expect(first.total.resultRub).toBe('743.00');
    expect(sum(first)).toBe('743.00');
  });

  it('субкопеечные цены: сумма отображаемых строк равна карточке до копейки', async () => {
    reset();
    op({ date: '2026-01-01', type: 'Buy', price: '1' });
    op({ date: '2026-01-01', type: 'Buy', instrument: 'GAZP', price: '1' });
    px('SBER', '2026-01-01', '1');
    px('GAZP', '2026-01-01', '1');
    op({ date: '2026-01-01', type: 'Coupon', price: '0.004' });
    op({ date: '2026-01-01', type: 'Coupon', instrument: 'GAZP', price: '0.004' });
    const dto = await service.performance({ scope: 'all', from: '2026-01-01', till: '2026-01-01' });
    expect(dto.total.resultRub).toBe('0.01');
    expect(sum(dto)).toBe('0.01');
  });
});

describe('P2: календарь Mac в 00:30, заголовочные даты и текущий FX', () => {
  it('Москва: локальный день, будущий till ограничен, FX только на сегодня', async () => {
    const oldTZ = process.env['TZ'];
    process.env['TZ'] = 'Europe/Moscow';
    vi.useFakeTimers({ toFake: ['Date'] });
    const fx = vi.spyOn(quotesStub, 'getFxRateOrNull');
    try {
      db.update(instruments).set({ currency: 'USD' }).where(eq(instruments.id, 'SBER')).run();
      for (const [instant, expected] of [
        ['2026-11-14T21:30:00Z', '2026-11-15'],
        ['2026-12-31T20:59:00Z', '2026-12-31'],
        ['2026-12-31T21:30:00Z', '2027-01-01'],
        ['2026-11-15T09:00:00Z', '2026-11-15'],
      ]) {
        vi.setSystemTime(new Date(instant));
        fx.mockClear();
        expect(valuation.cap('2030-01-01')).toBe(expected);
        const dto = await service.performance({
          scope: 'all',
          from: '2026-01-01',
          till: '2030-01-01',
        });
        expect(dto.till).toBe(expected);
        expect(dto.total.till).toBe(expected);
        expect(fx).toHaveBeenCalledWith('USD');
        fx.mockClear();
        await valuation.prepare('2026-01-02');
        expect(fx).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
      fx.mockRestore();
      if (oldTZ === undefined) delete process.env['TZ'];
      else process.env['TZ'] = oldTZ;
    }
  });
});

describe('P2 повторная проверка: счёт без сделок с бумагами', () => {
  it('единственная комиссия −7 видна в карточке и «Без инструмента» при любом срезе', async () => {
    db.delete(operations).run();
    db.delete(priceHistory).run();
    op({
      date: '2026-01-03',
      type: 'Fee',
      instrument: null,
      portfolio: 'p2',
      system: 's2',
      price: '7',
    });
    for (const query of [
      { scope: 'all' as const },
      { scope: 'portfolio' as const, id: 'p2' },
      { scope: 'system' as const, id: 's2', portfolioId: 'p2' },
    ]) {
      const dto = await service.performance({ ...query, from: '2026-01-01', till: '2026-01-04' });
      expect(dto.total.resultRub).toBe('-7.00');
      expect(dto.byInstrument.map((r) => [r.instrumentId, r.name, r.resultRub])).toEqual([
        [null, 'Без инструмента', '-7.00'],
      ]);
    }
    const series = await valuation.series({
      groupBy: 'instrument',
      portfolioId: 'p2',
      till: '2026-01-04',
    });
    expect(series.groups[0].points.at(-1)?.totalRub).toBe('-7.00');
    // Other accounts must not decide whether the fee-only account has a row.
    op({ date: '2026-01-01', type: 'Buy', price: '100', portfolio: 'p1' });
    expect(
      (await service.performance({ scope: 'portfolio', id: 'p2', till: '2026-01-04' })).total
        .resultRub,
    ).toBe('-7.00');
    expect((await service.performance({ scope: 'all', till: '2026-01-04' })).total.resultRub).toBe(
      '-7.00',
    );
  });
});
