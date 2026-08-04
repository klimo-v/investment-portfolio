import { describe, it, expect } from 'vitest';
import { cashBalanceRub } from './cash';
import type { Operation } from './schemas';

/**
 * Тесты денежного остатка. Числа взяты в форме, в которой их пишет импорт: у кэшевых
 * операций quantity = 1, а сумма лежит в price (см. parsers/broker-html-report.ts).
 */

function op(o: Partial<Operation>): Operation {
  return {
    date: '2025-01-01',
    systemId: 'sys',
    portfolioId: 'pf',
    instrumentId: 'ins',
    operationType: 'Buy',
    quantity: '0',
    price: '0',
    fee: '0',
    fxRate: '1',
    currency: 'RUB',
    ...o,
  } as Operation;
}

/** Кэшевая операция в том виде, в каком её кладёт импорт: количество 1, сумма в цене */
function cash(type: Operation['operationType'], amount: string): Operation {
  return op({ operationType: type, instrumentId: null, quantity: '1', price: amount });
}

describe('cashBalanceRub', () => {
  it('пустой журнал — ноль, а не NaN', () => {
    expect(cashBalanceRub([]).toString()).toBe('0');
  });

  it('ввод и вывод кэша', () => {
    const balance = cashBalanceRub([
      cash('Deposit', '100000'),
      cash('Deposit', '25000'),
      cash('Withdraw', '30000'),
    ]);
    expect(balance.toFixed(2)).toBe('95000.00');
  });

  it('покупка уменьшает остаток на сумму С комиссией', () => {
    // 1600 × 310.99 + 199.03 = 497783.03 (та же покупка SBER, что в engine.spec)
    const balance = cashBalanceRub([
      cash('Deposit', '500000'),
      op({ operationType: 'Buy', quantity: '1600', price: '310.99', fee: '199.03' }),
    ]);
    expect(balance.toFixed(2)).toBe('2216.97');
  });

  it('продажа увеличивает остаток на сумму ЗА ВЫЧЕТОМ комиссии', () => {
    // 1600 × 317 − 202.88 = 506997.12
    const balance = cashBalanceRub([
      op({ operationType: 'Sell', quantity: '1600', price: '317', fee: '202.88' }),
    ]);
    expect(balance.toFixed(2)).toBe('506997.12');
  });

  it('дивиденды и купоны приходят деньгами, налоги и комиссии уходят', () => {
    const balance = cashBalanceRub([
      cash('Dividend', '5000'),
      cash('Coupon', '1200'),
      cash('Tax', '806'),
      cash('Fee', '150'),
    ]);
    expect(balance.toFixed(2)).toBe('5244.00');
  });

  it('валютные операции приводятся к рублям по курсу операции', () => {
    // 100 × $10 × 90 = 90 000 ₽ ушло, дивиденд $50 × 92 = 4600 ₽ пришло
    const balance = cashBalanceRub([
      op({ operationType: 'Buy', quantity: '100', price: '10', fxRate: '90', currency: 'USD' }),
      op({
        operationType: 'Dividend',
        quantity: '1',
        price: '50',
        fxRate: '92',
        currency: 'USD',
      }),
    ]);
    expect(balance.toFixed(2)).toBe('-85400.00');
  });

  it('комиссия в валюте тоже конвертируется по курсу операции', () => {
    // (100 × 10 + 3) × 90 = 90 270
    const balance = cashBalanceRub([
      op({ operationType: 'Buy', quantity: '100', price: '10', fee: '3', fxRate: '90' }),
    ]);
    expect(balance.toFixed(2)).toBe('-90270.00');
  });

  it('парный перевод между портфелями схлопывается в ноль по всему журналу', () => {
    // Знак несут данные: исходящая сторона пишется отрицательной суммой
    const balance = cashBalanceRub([
      op({ operationType: 'Transfer', instrumentId: null, quantity: '1', price: '-50000' }),
      op({ operationType: 'Transfer', instrumentId: null, quantity: '1', price: '50000' }),
    ]);
    expect(balance.toString()).toBe('0');
  });

  it('в срезе по одному портфелю перевод остаётся видимым', () => {
    const balance = cashBalanceRub([
      op({ operationType: 'Transfer', instrumentId: null, quantity: '1', price: '50000' }),
    ]);
    expect(balance.toFixed(2)).toBe('50000.00');
  });

  it('отрицательный остаток отдаётся как есть — это сигнал о неполном журнале', () => {
    // Покупок больше, чем заведённых денег: часть пополнений в журнал не попала
    const balance = cashBalanceRub([
      cash('Deposit', '10000'),
      op({ operationType: 'Buy', quantity: '100', price: '150' }),
    ]);
    expect(balance.toFixed(2)).toBe('-5000.00');
  });

  it('не теряет копейки на длинной цепочке (decimal, не float)', () => {
    // 0.1 + 0.2 во float даёт 0.30000000000000004
    const balance = cashBalanceRub([cash('Deposit', '0.1'), cash('Deposit', '0.2')]);
    expect(balance.toString()).toBe('0.3');
  });
});
