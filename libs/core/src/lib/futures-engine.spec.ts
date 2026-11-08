import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import type { Operation } from './schemas';
import {
  calculatePositions,
  calculateTrades,
  realizedPnlInRange,
} from './engine';
import { futureUnrealizedPnl } from './futures-engine';
import { cashBalanceRub } from './cash';
import { compareOperations } from './operation-order';

/**
 * Фьючерс CNY-12.26 на сделках реального отчёта SESPS 27.10–05.11.2026 (14 сделок,
 * позиция 0 → −130 → 0 → −128). Цены в ₽ за контракт (множитель 1000 уже применён).
 * Эталон — расчёт ВМ брокера: по цене сделок и расчётной цене 12 387 итог должен
 * сойтись с вариационной маржой отчёта (204,00 − 11 117,00 = −10 913).
 */
const FUT = new Set(['CNY-12.26']);

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

const op = (t: T, i: number): Operation => ({
  id: `op${i}`,
  date: t[0],
  executedAt: t[1],
  systemId: 's1',
  portfolioId: 'p1',
  instrumentId: 'CNY-12.26',
  operationType: t[2],
  quantity: t[3],
  price: t[4],
  fee: t[5],
  fxRate: '1',
  currency: 'RUB',
  brokerRef: t[6],
});
const OPS = TRADES.map(op);

const totalFees = () => TRADES.reduce((s, t) => s.plus(t[5]), new Decimal(0));

describe('фьючерсы: позиция со знаком', () => {
  const [pos] = calculatePositions(OPS, { futureIds: FUT });

  it('итоговая позиция −128 контрактов, средняя 12 420,5, «вложено» 0', () => {
    expect(pos.quantity.toString()).toBe('-128');
    expect(pos.avgBuyPrice.toString()).toBe('12420.5');
    expect(pos.investedCcy.toString()).toBe('0');
    expect(pos.investedRub.toString()).toBe('0');
  });

  it('реализованный по цене −15 201 ₽, комиссия вычтена сразу', () => {
    const net = pos.realizedPnlRub;
    expect(net.plus(totalFees()).toNumber()).toBeCloseTo(-15201, 0);
  });

  it('нереализованный по расчётной 12 387: ≈ +4 288 ₽; итого равно ВМ отчёта −10 913', () => {
    const unrealized = futureUnrealizedPnl(pos, 12387);
    expect(unrealized.toNumber()).toBeCloseTo(4288, 0);
    const gross = pos.realizedPnlRub.plus(totalFees()).plus(unrealized);
    expect(gross.toNumber()).toBeCloseTo(-10913, 0);
  });

  it('порядок по времени: продажи 05.11 раньше покупок дали бы другой результат', () => {
    const wrongOrder = OPS.map((o) => ({ ...o, executedAt: o.operationType === 'Sell' ? '00:00:00' : o.executedAt }));
    const [wrong] = calculatePositions(wrongOrder, { futureIds: FUT });
    const gross = wrong.realizedPnlRub.plus(totalFees());
    expect(gross.toNumber()).toBeCloseTo(-10557, 0);
    expect(gross.toNumber()).not.toBeCloseTo(-15201, 0);
  });

  it('порядок не зависит от порядка записей в журнале (сортировка по дате, времени, номеру)', () => {
    const shuffled = [...OPS].reverse();
    const [p] = calculatePositions(shuffled, { futureIds: FUT });
    expect(p.realizedPnlRub.toString()).toBe(pos.realizedPnlRub.toString());
  });
});

describe('фьючерсы: прочие функции движка', () => {
  it('realizedPnlInRange: за весь период = реализованному позиции, за срез — только сделки среза', () => {
    const [all] = realizedPnlInRange(OPS, undefined, undefined, { futureIds: FUT });
    const [pos] = calculatePositions(OPS, { futureIds: FUT });
    expect(all.realizedPnlRub.toString()).toBe(pos.realizedPnlRub.toString());

    const [part] = realizedPnlInRange(OPS, '2026-11-05', undefined, { futureIds: FUT });
    const [before] = realizedPnlInRange(OPS, undefined, '2026-11-04', { futureIds: FUT });
    // результат до 05.11 + результат с 05.11 = всё
    expect(part.realizedPnlRub.plus(before.realizedPnlRub).toNumber()).toBeCloseTo(
      all.realizedPnlRub.toNumber(),
      6,
    );
  });

  it('calculateTrades: лонг 4, шорт 130 и шорт 128 — три отдельные сделки по возврату позиции в ноль', () => {
    const trades = calculateTrades(OPS, { futureIds: FUT });
    expect(trades.map((t) => t.status)).toEqual(['Closed', 'Closed', 'Open']);
    const open = trades[2];
    expect(open.quantity.toString()).toBe('-128');
    expect(open.qtySold.toString()).toBe('128');
    expect(open.investedRub.toString()).toBe('0');
    const sum = trades.reduce((s, t) => s.plus(t.realizedPnlRub), new Decimal(0));
    expect(sum.toString()).toBe(calculatePositions(OPS, { futureIds: FUT })[0].realizedPnlRub.toString());
  });

  it('переворот лонг → шорт одной сделкой: закрытие + новая сделка на остаток', () => {
    const flip: Operation[] = [
      { ...op(['2026-11-01', '10:00:00', 'Buy', '3', '10000', '0', 'a1'], 0) },
      { ...op(['2026-11-01', '11:00:00', 'Sell', '5', '10100', '0', 'a2'], 1) },
    ];
    const [pos] = calculatePositions(flip, { futureIds: FUT });
    expect(pos.quantity.toString()).toBe('-2');
    expect(pos.avgBuyPrice.toString()).toBe('10100');
    expect(pos.realizedPnlRub.toString()).toBe('300'); // (10100−10000)×3
    const trades = calculateTrades(flip, { futureIds: FUT });
    expect(trades.map((t) => t.status)).toEqual(['Closed', 'Open']);
    expect(trades[1].quantity.toString()).toBe('-2');
  });

  it('не-фьючерсы без futureIds считаются как раньше (long-only)', () => {
    const stock: Operation[] = [
      { ...op(['2026-11-01', '10:00:00', 'Buy', '10', '100', '0', 'b1'], 0), instrumentId: 'SBER' },
      { ...op(['2026-11-02', '10:00:00', 'Sell', '4', '110', '0', 'b2'], 1), instrumentId: 'SBER' },
    ];
    const [pos] = calculatePositions(stock);
    expect(pos.quantity.toString()).toBe('6');
    expect(pos.realizedPnlRub.toString()).toBe('40');
  });

  it('cashBalanceRub: сделки фьючерса не двигают кэш, двигает только реализованный (с комиссией)', () => {
    const dep: Operation = {
      date: '2026-10-01', systemId: 's1', portfolioId: 'p1', instrumentId: null,
      operationType: 'Deposit', quantity: '1', price: '100000', fee: '0', fxRate: '1', currency: 'RUB',
    };
    const cash = cashBalanceRub([dep, ...OPS], FUT);
    const [pos] = calculatePositions(OPS, { futureIds: FUT });
    expect(cash.toString()).toBe(new Decimal(100000).plus(pos.realizedPnlRub).toString());
    // без набора фьючерсов старое поведение: купил-продал по сумме контрактов — совсем другое число
    expect(cashBalanceRub([dep, ...OPS]).toString()).not.toBe(cash.toString());
  });

});

describe('фьючерсы: краевые случаи', () => {
  it('сделка с нулевым количеством не портит позицию (нет NaN) и не начисляет комиссию', () => {
    const zero: Operation = { ...op(['2026-11-01', '09:00:00', 'Buy', '0', '10000', '5', 'z1'], 0) };
    const real = op(['2026-11-01', '10:00:00', 'Buy', '2', '10000', '0', 'z2'], 1);
    const [pos] = calculatePositions([zero, real], { futureIds: FUT });
    expect(pos.quantity.toString()).toBe('2');
    expect(pos.avgBuyPrice.toString()).toBe('10000');
    expect(pos.realizedPnlRub.toString()).toBe('0');
  });
});

describe('compareOperations', () => {
  it('операции без времени сохраняют прежний порядок (устойчивая сортировка)', () => {
    const mk = (id: string, ref?: string): Operation => ({
      id, date: '2026-01-01', systemId: 's', portfolioId: 'p', operationType: 'Buy',
      quantity: '1', price: '1', fee: '0', fxRate: '1', currency: 'RUB', brokerRef: ref,
    });
    const arr = [mk('a', '9'), mk('b', '1'), mk('c', '5')];
    expect([...arr].sort(compareOperations).map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });
  it('при равном времени порядок по номеру сделки (числовой)', () => {
    const mk = (ref: string): Operation => ({
      date: '2026-01-01', executedAt: '10:00:00', systemId: 's', portfolioId: 'p', operationType: 'Buy',
      quantity: '1', price: '1', fee: '0', fxRate: '1', currency: 'RUB', brokerRef: ref,
    });
    const sorted = [mk('10'), mk('9'), mk('100')].sort(compareOperations).map((o) => o.brokerRef);
    expect(sorted).toEqual(['9', '10', '100']);
  });
});

import { tickerToExchangeCode, quikCodeToTicker } from './futures';
describe('tickerToExchangeCode', () => {
  it('CNY-12.26 ↔ CRZ6 в обе стороны', () => {
    expect(tickerToExchangeCode('CNY-12.26')).toBe('CRZ6');
    expect(quikCodeToTicker('CRZ6')).toBe('CNY-12.26');
    expect(tickerToExchangeCode('CNY-3.27')).toBe('CRH7');
  });
  it('неизвестная серия и мусор — null', () => {
    expect(tickerToExchangeCode('XXX-12.26')).toBeNull();
    expect(tickerToExchangeCode('SBER')).toBeNull();
  });
});
