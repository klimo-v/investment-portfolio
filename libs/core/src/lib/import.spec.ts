import { describe, it, expect } from 'vitest';
import {
  normalizeDate,
  classifyOperationType,
  normalizeRow,
  makeDedupeKey,
  type RawRow,
} from './import';

/** Резолверы для тестов — сопоставляют имена из данных пользователя в id */
const resolvers = {
  resolveSystem: (n?: string) =>
    ({ Верников: 'vernikov', Верников_трейдинг: 'vernikov_trading' })[n ?? ''] ?? null,
  resolvePortfolio: (b?: string) => (b === 'Tinkoff' ? 'tinkoff' : null),
  resolveInstrument: (t?: string) => t ?? null,
};

describe('normalizeDate', () => {
  it('MM/DD/YYYY (формат Google Sheets пользователя)', () => {
    expect(normalizeDate('2/27/2025')).toBe('2025-02-27');
    expect(normalizeDate('3/11/2025')).toBe('2025-03-11');
  });
  it('DD.MM.YYYY (РФ-отчёты)', () => {
    expect(normalizeDate('27.02.2025')).toBe('2025-02-27');
  });
  it('уже ISO', () => {
    expect(normalizeDate('2025-02-27')).toBe('2025-02-27');
  });
  it('нераспознанное → null', () => {
    expect(normalizeDate('вчера')).toBeNull();
  });
});

describe('classifyOperationType', () => {
  it('перевод между портфелями имеет приоритет', () => {
    const r = classifyOperationType({ date: '', tradeType: 'Buy', betweenPortfolios: 'Да' });
    expect(r.type).toBe('Transfer');
    expect(r.confidence).toBe('ok');
  });
  it('Buy/Sell (англ и рус)', () => {
    expect(classifyOperationType({ date: '', tradeType: 'Buy' }).type).toBe('Buy');
    expect(classifyOperationType({ date: '', tradeType: 'Продажа' }).type).toBe('Sell');
  });
  it('Deposit/Withdraw/Tax', () => {
    expect(classifyOperationType({ date: '', tradeType: 'Deposit' }).type).toBe('Deposit');
    expect(classifyOperationType({ date: '', tradeType: 'Withdraw' }).type).toBe('Withdraw');
    expect(classifyOperationType({ date: '', tradeType: 'Tax' }).type).toBe('Tax');
  });
  it('неизвестный тип → warn', () => {
    const r = classifyOperationType({ date: '', tradeType: 'НечтоСтранное' });
    expect(r.confidence).toBe('warn');
    expect(r.reason).toContain('Неизвестный');
  });
});

describe('normalizeRow — реальная сделка SBER', () => {
  it('покупка SBER 1600 по 310.99 (из листа Сделки)', () => {
    const raw: RawRow = {
      date: '2/27/2025',
      system: 'Верников_трейдинг',
      instrumentType: 'Stock',
      ticker: 'SBER',
      currency: 'RUB',
      broker: 'Tinkoff',
      tradeType: 'Buy',
      quantity: '1,600.00',
      price: '310.99',
      fee: '199.03',
      fxRate: '1.00',
    };
    const res = normalizeRow(raw, resolvers);
    expect('operation' in res).toBe(true);
    if ('operation' in res) {
      expect(res.operation.date).toBe('2025-02-27');
      expect(res.operation.systemId).toBe('vernikov_trading');
      expect(res.operation.portfolioId).toBe('tinkoff');
      expect(res.operation.instrumentId).toBe('SBER');
      expect(res.operation.operationType).toBe('Buy');
      expect(res.operation.quantity).toBe('1600.00'); // разделитель разрядов убран
      expect(res.operation.price).toBe('310.99');
      expect(res.operation.fee).toBe('199.03');
      expect(res.confidence).toBe('ok');
    }
  });

  it('депозит кэша (Deposit RUB)', () => {
    const raw: RawRow = {
      date: '2/27/2025',
      system: 'Верников_трейдинг',
      currency: 'RUB',
      broker: 'Tinkoff',
      tradeType: 'Deposit',
      quantity: '1',
      price: '497,782.00',
    };
    const res = normalizeRow(raw, resolvers);
    if ('operation' in res) {
      expect(res.operation.operationType).toBe('Deposit');
      expect(res.operation.price).toBe('497782.00');
      expect(res.operation.instrumentId).toBeNull();
    }
  });

  it('ошибка при неизвестной системе', () => {
    const res = normalizeRow(
      { date: '2/27/2025', system: 'НетТакой', broker: 'Tinkoff', tradeType: 'Buy' },
      resolvers,
    );
    expect('error' in res).toBe(true);
  });
});

describe('makeDedupeKey', () => {
  it('одинаковые операции → одинаковый ключ', () => {
    const op = {
      date: '2025-02-27',
      systemId: 'vernikov',
      portfolioId: 'tinkoff',
      instrumentId: 'SBER',
      operationType: 'Buy' as const,
      quantity: '1600',
      price: '310.99',
      fee: '199.03',
      fxRate: '1',
      currency: 'RUB',
    };
    expect(makeDedupeKey(op)).toBe(makeDedupeKey({ ...op }));
  });
});
