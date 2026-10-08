import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  calculatePositions,
  calculateTrades,
  marketValueRub,
  realizedPnlInRange,
  unrealizedPnl,
} from './engine';
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

  it('закрытие валютной позиции: realizedPnlRub — по курсу продажи, отдельно от realizedPnlCcy', () => {
    const [pos] = calculatePositions([
      op({
        instrumentId: 'BOND',
        operationType: 'Buy',
        quantity: '28',
        price: '100',
        fxRate: '90',
        currency: 'USD',
      }),
      op({
        instrumentId: 'BOND',
        operationType: 'Sell',
        quantity: '28',
        price: '110',
        fxRate: '95',
        currency: 'USD',
      }),
    ]);
    // P&L в валюте = 28*110 - 28*100 = 280; в рублях — по курсу продажи: 280*95 = 26600
    // (этого поля не было в PositionResult — без него positions() показывал P&L
    // закрытой позиции без учёта реализованного результата, см. operations.service.ts)
    expect(pos.realizedPnlCcy.toString()).toBe('280');
    expect(pos.realizedPnlRub.toString()).toBe('26600');
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

describe('realizedPnlInRange — реализованный P&L за окно, себестоимость по всей истории', () => {
  it('продажа внутри окна: SBER 1600@310.99 → 1600@317, P&L ≈ 9214.09', () => {
    const [r] = realizedPnlInRange(
      [
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
      ],
      '2025-03-01',
      '2025-03-31',
    );
    expect(r.realizedPnlRub.toFixed(2)).toBe('9214.09');
  });

  it('покупка ДО окна, продажа ВНУТРИ окна — себестоимость всё равно от полной истории', () => {
    const [r] = realizedPnlInRange(
      [
        op({ date: '2025-01-01', instrumentId: 'X', operationType: 'Buy', quantity: '100', price: '10', fee: '0' }),
        op({ date: '2025-06-15', instrumentId: 'X', operationType: 'Sell', quantity: '100', price: '30', fee: '0' }),
      ],
      '2025-06-01',
      '2025-06-30',
    );
    // себестоимость 100*10 = 1000 (из покупки ДО окна), выручка 100*30 = 3000 → P&L = 2000
    expect(r.realizedPnlRub.toString()).toBe('2000');
  });

  it('продажа ДО начала окна не учитывается', () => {
    const [r] = realizedPnlInRange(
      [
        op({ date: '2025-01-01', instrumentId: 'X', operationType: 'Buy', quantity: '100', price: '10', fee: '0' }),
        op({ date: '2025-02-01', instrumentId: 'X', operationType: 'Sell', quantity: '100', price: '30', fee: '0' }),
      ],
      '2025-03-01',
      '2025-03-31',
    );
    expect(r.realizedPnlRub.toString()).toBe('0');
  });

  it('продажа ПОСЛЕ конца окна (till) не учитывается', () => {
    const [r] = realizedPnlInRange(
      [
        op({ date: '2025-01-01', instrumentId: 'X', operationType: 'Buy', quantity: '100', price: '10', fee: '0' }),
        op({ date: '2025-06-01', instrumentId: 'X', operationType: 'Sell', quantity: '100', price: '30', fee: '0' }),
      ],
      undefined,
      '2025-03-31',
    );
    expect(r.realizedPnlRub.toString()).toBe('0');
  });

  it('без from/till — эквивалент реализованного P&L за всё время (сходится с calculatePositions)', () => {
    const ops = [
      op({ instrumentId: 'X', operationType: 'Buy', quantity: '100', price: '10', fee: '0' }),
      op({ instrumentId: 'X', operationType: 'Buy', quantity: '100', price: '20', fee: '0' }),
      op({ instrumentId: 'X', operationType: 'Sell', quantity: '50', price: '30', fee: '0' }),
    ];
    const [r] = realizedPnlInRange(ops);
    const [pos] = calculatePositions(ops);
    expect(r.realizedPnlRub.toString()).toBe(pos.realizedPnlCcy.toString());
  });
});

describe('calculateTrades — закрытые/открытые/частично закрытые', () => {
  it('закрытая сделка SBER: покупка 1600@310.99 + продажа 1600@317', () => {
    const [trade] = calculateTrades([
      op({
        id: 'o1',
        date: '2025-02-27',
        instrumentId: 'SBER',
        operationType: 'Buy',
        quantity: '1600',
        price: '310.99',
        fee: '199.03',
      }),
      op({
        id: 'o2',
        date: '2025-03-07',
        instrumentId: 'SBER',
        operationType: 'Sell',
        quantity: '1600',
        price: '317',
        fee: '202.88',
      }),
    ]);
    expect(trade.status).toBe('Closed');
    expect(trade.investedCcy.toString()).toBe('0');
    expect(trade.proceedsCcy.toFixed(2)).toBe('506997.12');
    expect(trade.realizedPnlCcy.toFixed(2)).toBe('9214.09');
    expect(trade.qtyBought.toString()).toBe('1600');
    expect(trade.qtySold.toString()).toBe('1600');
    expect(trade.quantity.toString()).toBe('0');
    expect(trade.openedAt).toBe('2025-02-27');
    expect(trade.closedAt).toBe('2025-03-07');
    expect(trade.operationIds).toEqual(['o1', 'o2']);
  });

  it('частично закрытая сделка остаётся в статусе Partial без closedAt', () => {
    const [trade] = calculateTrades([
      op({ id: 'o1', instrumentId: 'X', operationType: 'Buy', quantity: '100', price: '10' }),
      op({ id: 'o2', instrumentId: 'X', operationType: 'Buy', quantity: '100', price: '20' }),
      op({ id: 'o3', instrumentId: 'X', operationType: 'Sell', quantity: '50', price: '30' }),
    ]);
    expect(trade.status).toBe('Partial');
    expect(trade.closedAt).toBeNull();
    expect(trade.quantity.toString()).toBe('150');
    expect(trade.qtyBought.toString()).toBe('200');
    expect(trade.qtySold.toString()).toBe('50');
    expect(trade.realizedPnlCcy.toString()).toBe('750');
  });

  it('открытая сделка без продаж не попадает в закрытые', () => {
    const trades = calculateTrades([
      op({ id: 'o1', instrumentId: 'Y', operationType: 'Buy', quantity: '10', price: '100' }),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].status).toBe('Open');
    expect(trades[0].closedAt).toBeNull();
  });

  it('повторное открытие после закрытия создаёт новую сделку', () => {
    const trades = calculateTrades([
      op({ id: 'o1', date: '2025-01-01', instrumentId: 'Z', operationType: 'Buy', quantity: '10', price: '100' }),
      op({ id: 'o2', date: '2025-01-05', instrumentId: 'Z', operationType: 'Sell', quantity: '10', price: '110' }),
      op({ id: 'o3', date: '2025-02-01', instrumentId: 'Z', operationType: 'Buy', quantity: '5', price: '120' }),
    ]);
    expect(trades).toHaveLength(2);
    const [first, second] = trades;
    expect(first.status).toBe('Closed');
    expect(first.operationIds).toEqual(['o1', 'o2']);
    expect(second.status).toBe('Open');
    expect(second.operationIds).toEqual(['o3']);
  });

  it('дивиденд накапливается в открытую сделку', () => {
    const [trade] = calculateTrades([
      op({ id: 'o1', instrumentId: 'LKOH', operationType: 'Buy', quantity: '29', price: '7105.17' }),
      op({ id: 'o2', instrumentId: 'LKOH', operationType: 'Dividend', quantity: '1', price: '31733' }),
    ]);
    expect(trade.dividendsRub.toFixed(2)).toBe('31733.00');
  });
});

describe('marketValueRub — рыночная оценка остатка', () => {
  it('НКД входит в стоимость: 538 ОФЗ SU29015RMFS3 по 992.60 + НКД 8.87', () => {
    const value = marketValueRub({
      quantity: '538',
      price: '992.6',
      accruedInterest: '8.87',
      fxRate: 1,
    });
    // 538 × 1001.47 — на 4 772.06 ₽ больше «чистой» оценки, ровно как у брокера
    expect(value.toFixed(2)).toBe('538790.86');
    expect(value.minus(new Decimal('538').mul('992.6')).toFixed(2)).toBe('4772.06');
  });

  it('без НКД (акции, ETF) формула вырождается в цену × количество', () => {
    const value = marketValueRub({ quantity: '70176', price: '19.16', accruedInterest: null, fxRate: 1 });
    expect(value.toFixed(2)).toBe('1344572.16');
  });

  it('валютная бумага пересчитывается по курсу вместе с НКД', () => {
    // 28 шт по $100.3619 + НКД $1.659954, курс 83 ₽/$ — валюты цены и НКД совпадают
    const value = marketValueRub({
      quantity: '28',
      price: '100.3619',
      fxRate: '83',
      accruedInterest: '1.659954',
    });
    expect(value.toFixed(2)).toBe('237098.79');
  });

  it('НКД в своей валюте: цена в долларах, НКД в рублях (RU000A10B4K3 на TQCB)', () => {
    // цена $100.3999 при курсе 84.233 ₽/$, НКД 26.97024 ₽ — уже в рублях
    const value = marketValueRub({
      quantity: '28',
      price: '100.3999',
      fxRate: '84.233',
      accruedInterest: '26.97024',
      accruedFxRate: 1,
    });
    // сходится со стоимостью у брокера (237 551 ₽), а не 300 579 ₽
    expect(Number(value.toFixed(2))).toBeCloseTo(237551, 0);
  });

  it('пересчёт рублёвого НКД по курсу доллара — та самая ошибка в 84 раза', () => {
    const wrong = marketValueRub({
      quantity: '28',
      price: '100.3999',
      fxRate: '84.233',
      accruedInterest: '26.97024',
      accruedFxRate: '84.233',
    });
    const right = marketValueRub({
      quantity: '28',
      price: '100.3999',
      fxRate: '84.233',
      accruedInterest: '26.97024',
      accruedFxRate: 1,
    });
    expect(wrong.minus(right).toFixed(0)).toBe('62855');
  });
});

describe('валюта сделок отделена от валюты инструмента', () => {
  it('замещающая облигация: покупка за рубли даёт tradeCurrency=RUB', () => {
    const [pos] = calculatePositions([
      op({
        instrumentId: 'RU000A10B4K3',
        operationType: 'Buy',
        quantity: '28',
        price: '8452.21',
        currency: 'RUB',
      }),
    ]);
    // средняя выражена в рублях — подписывать её валютой номинала (USD) нельзя
    expect(pos.tradeCurrency).toBe('RUB');
    expect(pos.avgBuyPrice.toFixed(2)).toBe('8452.21');
  });

  it('берётся валюта последней покупки — она формирует текущий остаток', () => {
    const [pos] = calculatePositions([
      op({ date: '2025-01-01', instrumentId: 'X', quantity: '1', price: '100', currency: 'USD' }),
      op({ date: '2025-02-01', instrumentId: 'X', quantity: '1', price: '100', currency: 'RUB' }),
    ]);
    expect(pos.tradeCurrency).toBe('RUB');
  });
});
