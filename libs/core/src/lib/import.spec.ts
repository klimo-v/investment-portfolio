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

describe('normalizeRow — выбор системы по тикеру в рамках импорта (docs/04-roadmap.md §3.1)', () => {
  /**
   * Резолверы как для HTML-отчёта: raw.system никогда не задан, только батч-дефолт +
   * точечный выбор пользователя для конкретного тикера — НЕ персистентное правило:
   * тот же тикер в другом импорте может уйти в другую систему, поэтому выбор
   * передаётся отдельно на каждый preview()/commit(), а не хранится в БД.
   */
  const htmlResolvers = {
    resolveSystem: (name?: string, ticker?: string) => {
      if (ticker === 'SBER') return 'vernikov_trading'; // выбрано пользователем для этого импорта
      return 'vernikov'; // батч-дефолт
    },
    resolvePortfolio: () => 'tinkoff',
    resolveInstrument: (t?: string) => t ?? null,
    systemChosenForTicker: (ticker?: string) => ticker === 'SBER',
  };

  const rawFor = (ticker: string): RawRow => ({
    date: '01.01.2026',
    ticker,
    currency: 'RUB',
    tradeType: 'Покупка',
    quantity: '1',
    price: '100',
  });

  it('система выбрана явно для тикера в этом импорте → confidence ok, systemUncertain не выставлен', () => {
    const res = normalizeRow(rawFor('SBER'), htmlResolvers);
    if (!('operation' in res)) throw new Error('expected operation');
    expect(res.operation.systemId).toBe('vernikov_trading');
    expect(res.confidence).toBe('ok');
    expect(res.systemUncertain).toBeFalsy();
  });

  it('система пришла батч-дефолтом (для тикера явно не выбрана) → confidence warn, systemUncertain=true', () => {
    const res = normalizeRow(rawFor('SBMM'), htmlResolvers);
    if (!('operation' in res)) throw new Error('expected operation');
    expect(res.operation.systemId).toBe('vernikov'); // всё равно импортируется, не error
    expect(res.confidence).toBe('warn');
    expect(res.systemUncertain).toBe(true);
    expect(res.reason).toContain('SBMM');
  });

  it('без systemChosenForTicker (напр. CSV, где raw.system обычно задан) — поведение не меняется', () => {
    const res = normalizeRow(rawFor('SBMM'), {
      resolveSystem: () => 'vernikov',
      resolvePortfolio: () => 'tinkoff',
      resolveInstrument: (t?: string) => t ?? null,
      // systemChosenForTicker не передан
    });
    if (!('operation' in res)) throw new Error('expected operation');
    expect(res.confidence).toBe('ok');
    expect(res.systemUncertain).toBeFalsy();
  });

  it('один и тот же тикер в двух РАЗНЫХ импортах может резолвиться в разные системы — выбор не переживает вызов', () => {
    const firstImport = normalizeRow(rawFor('SBER'), {
      resolveSystem: (n?: string, t?: string) => (t === 'SBER' ? 'vernikov_trading' : 'vernikov'),
      resolvePortfolio: () => 'tinkoff',
      resolveInstrument: (t?: string) => t ?? null,
      systemChosenForTicker: (t?: string) => t === 'SBER',
    });
    // "новый импорт" — независимый вызов с другим выбором пользователя для того же тикера
    const secondImport = normalizeRow(rawFor('SBER'), {
      resolveSystem: (n?: string, t?: string) => (t === 'SBER' ? 'vernikov' : 'vernikov_trading'),
      resolvePortfolio: () => 'tinkoff',
      resolveInstrument: (t?: string) => t ?? null,
      systemChosenForTicker: (t?: string) => t === 'SBER',
    });
    if (!('operation' in firstImport) || !('operation' in secondImport)) {
      throw new Error('expected operation');
    }
    expect(firstImport.operation.systemId).toBe('vernikov_trading');
    expect(secondImport.operation.systemId).toBe('vernikov');
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

  it('brokerRef в приоритете: две РАЗНЫЕ сделки с одинаковыми цифрами не схлопываются в дубль', () => {
    // регулярный автоинвест: один и тот же тикер/дата/кол-во/цена, но разные сделки
    const base = {
      date: '2026-01-05',
      systemId: 'vernikov',
      portfolioId: 'tinkoff',
      instrumentId: 'TMON',
      operationType: 'Buy' as const,
      quantity: '1',
      price: '133.81',
      fee: '0',
      fxRate: '1',
      currency: 'RUB',
    };
    const first = { ...base, brokerRef: '9796362990' };
    const second = { ...base, brokerRef: '9796356260' };
    expect(makeDedupeKey(first)).not.toBe(makeDedupeKey(second));
  });

  it('без brokerRef — прежнее поведение (хэш по значениям, одинаковые → одинаковый ключ)', () => {
    const op = {
      date: '2026-01-05',
      systemId: 'vernikov',
      portfolioId: 'tinkoff',
      instrumentId: 'TMON',
      operationType: 'Buy' as const,
      quantity: '1',
      price: '133.81',
      fee: '0',
      fxRate: '1',
      currency: 'RUB',
    };
    expect(makeDedupeKey(op)).toBe(makeDedupeKey({ ...op }));
  });
});
