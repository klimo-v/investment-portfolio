import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { calculatePositions, unrealizedPnl } from './engine';
import type { Operation } from './schemas';

/**
 * Тесты движка на РЕАЛЬНЫХ цифрах пользователя из docs/02-data-model.md.
 * Приоритет №1 (CLAUDE.md §10) — финансовая логика, где ошибка дороже всего.
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

describe('calculatePositions — средневзвешенная цена', () => {
  it('простая покупка SBER: 1600 шт по 310.99 + комиссия 199.03', () => {
    const [pos] = calculatePositions([
      op({
        date: '2025-02-27',
        instrumentId: 'SBER',
        operationType: 'Buy',
        quantity: '1600',
        price: '310.99',
        fee: '199.03',
      }),
    ]);
    // вложено = 1600*310.99 + 199.03 = 497783.03 (совпадает с листом «Закрытые сделки»)
    expect(pos.investedCcy.toFixed(2)).toBe('497783.03');
    expect(pos.quantity.toString()).toBe('1600');
  });

  it('закрытие SBER: продажа 1600 по 317 → реализованный P&L ≈ 9214.09', () => {
    const [pos] = calculatePositions([
      op({
        date: '2025-02-27',
        instrumentId: 'SBER',
        operationType: 'Buy',
        quantity: '1600',
        price: '310.99',
        fee: '199.03',
      }),
      op({
        date: '2025-03-07',
        instrumentId: 'SBER',
        operationType: 'Sell',
        quantity: '1600',
        price: '317',
        fee: '202.88',
      }),
    ]);
    // выручка 1600*317 - 202.88 = 506997.12; себестоимость 497783.03; P&L = 9214.09
    expect(pos.realizedPnlCcy.toFixed(2)).toBe('9214.09');
    expect(pos.quantity.toString()).toBe('0');
    expect(pos.investedCcy.toString()).toBe('0');
  });

  it('частичная продажа: средняя цена остатка сохраняется', () => {
    const [pos] = calculatePositions([
      op({ instrumentId: 'X', operationType: 'Buy', quantity: '100', price: '10', fee: '0' }),
      op({ instrumentId: 'X', operationType: 'Buy', quantity: '100', price: '20', fee: '0' }),
      // средняя = (1000+2000)/200 = 15
      op({ instrumentId: 'X', operationType: 'Sell', quantity: '50', price: '30', fee: '0' }),
    ]);
    expect(pos.avgBuyPrice.toString()).toBe('15');
    expect(pos.quantity.toString()).toBe('150');
    // вложено-нетто = 3000 - 50*15 = 2250
    expect(pos.investedCcy.toString()).toBe('2250');
    // реализованный P&L = 50*30 - 50*15 = 750
    expect(pos.realizedPnlCcy.toString()).toBe('750');
  });
});

describe('calculatePositions — дивиденды и купоны', () => {
  it('дивиденд LKOH 31733 руб накапливается в позицию', () => {
    const [pos] = calculatePositions([
      op({ instrumentId: 'LKOH', operationType: 'Buy', quantity: '29', price: '7105.17' }),
      op({
        instrumentId: 'LKOH',
        operationType: 'Dividend',
        quantity: '1',
        price: '31733',
        fxRate: '1',
      }),
    ]);
    expect(pos.dividendsRub.toFixed(2)).toBe('31733.00');
  });
});

describe('unrealizedPnl', () => {
  it('нереализованный P&L = текущая стоимость − вложено', () => {
    const [pos] = calculatePositions([
      op({ instrumentId: 'Y', operationType: 'Buy', quantity: '10', price: '100', fee: '0' }),
    ]);
    // текущая цена 150 → стоимость 1500, вложено 1000, P&L = 500
    expect(unrealizedPnl(pos, new Decimal('150')).toString()).toBe('500');
  });
});

describe('Transfer не искажает P&L', () => {
  it('перевод между портфелями игнорируется в расчёте позиции', () => {
    const positions = calculatePositions([
      op({ instrumentId: 'Z', operationType: 'Buy', quantity: '10', price: '100' }),
      op({ instrumentId: 'Z', operationType: 'Transfer', quantity: '5', price: '100' }),
    ]);
    // Transfer пропущен → позиция как будто только покупка
    expect(positions).toHaveLength(1);
    expect(positions[0].quantity.toString()).toBe('10');
  });
});
