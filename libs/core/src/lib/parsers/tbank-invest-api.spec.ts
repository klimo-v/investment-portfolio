import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  mapTbankOperations,
  moneyToDecimal,
  type TbankInstrumentRef,
  type TbankOperationItem,
} from './tbank-invest-api';
import { makeDedupeKey, normalizeRow, type RawRow } from '../import';

/**
 * Тесты маппера T-Invest API. Фикстуры синтетические (реальные ответы содержат
 * номера счетов и ПДн), но структура и цифры — как в настоящих ответах брокера.
 * Приоритет — денежная арифметика и дедупликация (CLAUDE.md §10).
 */

const SBER: TbankInstrumentRef = {
  ticker: 'SBER',
  isin: 'RU0009029540',
  name: 'Сбербанк России',
  currency: 'rub',
  instrumentType: 'share',
};

const instruments = new Map([['uid-sber', SBER]]);

/** Операция-покупка с двумя частичными исполнениями */
function buyWithTwoTrades(): TbankOperationItem {
  return {
    id: 'op-1',
    date: '2026-03-15T10:30:00Z',
    type: 'OPERATION_TYPE_BUY',
    description: 'Покупка ЦБ',
    state: 'OPERATION_STATE_EXECUTED',
    instrumentUid: 'uid-sber',
    figi: 'BBG004730N88',
    instrumentType: 'share',
    payment: { currency: 'rub', units: '-30000', nano: 0 },
    price: { currency: 'rub', units: '300', nano: 0 },
    commission: { currency: 'rub', units: '-8', nano: -700000000 }, // -8.7
    quantity: '100',
    tradesInfo: {
      trades: [
        {
          num: '4000000001',
          date: '2026-03-15T10:30:00Z',
          quantity: '60',
          price: { currency: 'rub', units: '300', nano: 0 },
        },
        {
          num: '4000000002',
          date: '2026-03-15T10:31:00Z',
          quantity: '40',
          price: { currency: 'rub', units: '300', nano: 0 },
        },
      ],
    },
  };
}

describe('moneyToDecimal', () => {
  it('складывает units и nano, знак несут оба поля', () => {
    expect(moneyToDecimal({ units: '100', nano: 500000000 }).toFixed()).toBe('100.5');
    expect(moneyToDecimal({ units: '-8', nano: -700000000 }).toFixed()).toBe('-8.7');
    expect(moneyToDecimal({ units: '0', nano: -10000000 }).toFixed()).toBe('-0.01');
    expect(moneyToDecimal({ units: '42' }).toFixed()).toBe('42');
    expect(moneyToDecimal(undefined).toFixed()).toBe('0');
  });

  it('держит наноточность там, где float её теряет', () => {
    // 0.1 + 0.2 во float даёт 0.30000000000000004
    const sum = moneyToDecimal({ units: '0', nano: 100000000 }).plus(
      moneyToDecimal({ units: '0', nano: 200000000 }),
    );
    expect(sum.toFixed()).toBe('0.3');
    expect(moneyToDecimal({ units: '0', nano: 123456789 }).toFixed()).toBe('0.123456789');
  });

  it('не теряет точность на суммах за пределами безопасного целого', () => {
    expect(moneyToDecimal({ units: '9007199254740993', nano: 0 }).toFixed()).toBe(
      '9007199254740993',
    );
  });
});

describe('mapTbankOperations — сделки', () => {
  it('разворачивает операцию в строку на каждое частичное исполнение', () => {
    const rows = mapTbankOperations([buyWithTwoTrades()], '2000000001', instruments);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.brokerRef)).toEqual(['4000000001', '4000000002']);
    expect(rows.map((r) => r.quantity)).toEqual(['60', '40']);
    expect(rows.every((r) => r.tradeType === 'buy')).toBe(true);
    expect(rows.every((r) => r.ticker === 'SBER')).toBe(true);
    expect(rows.every((r) => r.currency === 'RUB')).toBe(true);
    expect(rows.every((r) => r.instrumentType === 'Stock')).toBe(true);
    expect(rows.every((r) => r.accountRef === '2000000001')).toBe(true);
    expect(rows[0].date).toBe('2026-03-15');
  });

  it('раскладывает комиссию по сделкам без потери копеек', () => {
    const rows = mapTbankOperations([buyWithTwoTrades()], '2000000001', instruments);
    const total = rows.reduce((acc, r) => acc.plus(r.fee ?? '0'), new Decimal(0));

    // 8.7 на объёмы 60/40 → 5.22 и 3.48, в сумме ровно 8.7
    expect(rows.map((r) => r.fee)).toEqual(['5.22', '3.48']);
    expect(total.toFixed()).toBe('8.7');
  });

  it('отдаёт остаток округления последней сделке, сумма сходится точно', () => {
    const item = buyWithTwoTrades();
    item.commission = { currency: 'rub', units: '0', nano: -10000000 }; // -0.01 на две сделки
    const rows = mapTbankOperations([item], '2000000001', instruments);
    const total = rows.reduce((acc, r) => acc.plus(r.fee ?? '0'), new Decimal(0));

    expect(total.toFixed()).toBe('0.01');
  });

  it('сделка без списка исполнений даёт одну строку с номером операции', () => {
    const item = buyWithTwoTrades();
    delete item.tradesInfo;
    const rows = mapTbankOperations([item], '2000000001', instruments);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brokerRef: 'op-1', quantity: '100', price: '300', fee: '8.7' });
  });

  it('берёт положительные количество/цену/комиссию — направление задаёт тип операции', () => {
    const item = buyWithTwoTrades();
    item.type = 'OPERATION_TYPE_SELL';
    item.payment = { currency: 'rub', units: '30000', nano: 0 };
    const rows = mapTbankOperations([item], '2000000001', instruments);

    expect(rows.every((r) => !r.quantity?.startsWith('-'))).toBe(true);
    expect(rows.every((r) => !r.price?.startsWith('-'))).toBe(true);
    expect(rows.every((r) => !r.fee?.startsWith('-'))).toBe(true);
    expect(rows[0].tradeType).toBe('sell');
  });
});

describe('mapTbankOperations — выплаты и налоги', () => {
  const dividend: TbankOperationItem = {
    id: 'op-div',
    date: '2026-05-20T00:00:00Z',
    type: 'OPERATION_TYPE_DIVIDEND',
    description: 'Выплата дивидендов',
    state: 'OPERATION_STATE_EXECUTED',
    instrumentUid: 'uid-sber',
    payment: { currency: 'rub', units: '3400', nano: 0 },
    quantity: '100',
  };
  const dividendTax: TbankOperationItem = {
    id: 'op-div-tax',
    parentOperationId: 'op-div',
    date: '2026-05-20T00:00:00Z',
    type: 'OPERATION_TYPE_DIVIDEND_TAX',
    description: 'Удержание налога по дивидендам',
    state: 'OPERATION_STATE_EXECUTED',
    instrumentUid: 'uid-sber',
    payment: { currency: 'rub', units: '-442', nano: 0 },
  };

  it('сворачивает налог в родительский дивиденд — одна строка нетто', () => {
    const rows = mapTbankOperations([dividend, dividendTax], '2000000001', instruments);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tradeType: 'dividend',
      ticker: 'SBER',
      quantity: '1',
      price: '2958', // 3400 − 442
      fee: '0',
    });
    expect(rows[0].note).toContain('нетто');
  });

  it('налог без родителя в выборке остаётся отдельной операцией', () => {
    const rows = mapTbankOperations([dividendTax], '2000000001', instruments);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tradeType: 'tax', quantity: '1', price: '442' });
  });

  it('пополнение счёта: вся сумма в цене, без инструмента', () => {
    const rows = mapTbankOperations(
      [
        {
          id: 'op-in',
          date: '2026-01-09T08:00:00Z',
          type: 'OPERATION_TYPE_INPUT',
          state: 'OPERATION_STATE_EXECUTED',
          payment: { currency: 'rub', units: '50000', nano: 0 },
        },
      ],
      '2000000001',
    );

    expect(rows[0]).toMatchObject({
      tradeType: 'deposit',
      quantity: '1',
      price: '50000',
      ticker: undefined,
    });
  });
});

describe('mapTbankOperations — фильтры и незнакомые типы', () => {
  it('берёт только исполненные операции', () => {
    const canceled = { ...buyWithTwoTrades(), state: 'OPERATION_STATE_CANCELED' };
    const inProgress = { ...buyWithTwoTrades(), state: 'OPERATION_STATE_PROGRESS' };

    expect(mapTbankOperations([canceled, inProgress], '2000000001', instruments)).toHaveLength(0);
  });

  it('незнакомый тип операции не превращается в покупку, а доходит до предпросмотра как warn', () => {
    const rows = mapTbankOperations(
      [
        {
          id: 'op-x',
          date: '2026-04-01T00:00:00Z',
          type: 'OPERATION_TYPE_SOMETHING_NEW',
          state: 'OPERATION_STATE_EXECUTED',
          payment: { currency: 'rub', units: '10', nano: 0 },
          quantity: '1',
        },
      ],
      '2000000001',
    );

    expect(rows[0].tradeType).toBe('OPERATION_TYPE_SOMETHING_NEW');

    const normalized = normalizeRow(rows[0], {
      resolveSystem: () => 'sys',
      resolvePortfolio: () => 'pf',
      resolveInstrument: () => ({ instrumentId: null }),
    });
    expect('error' in normalized).toBe(false);
    expect((normalized as { confidence: string }).confidence).toBe('warn');
  });

  it('без справочника инструментов тикера нет, figi и uid — отдельные идентификаторы', () => {
    const rows = mapTbankOperations([buyWithTwoTrades()], '2000000001');

    expect(rows[0].ticker).toBeUndefined();
    expect(rows[0].identifiers).toEqual({ figi: 'BBG004730N88', tbankUid: 'uid-sber' });
    expect(rows[0].name).toBeUndefined();
  });

  it('со справочником: тикер — биржевой, ISIN/figi/uid не теряются', () => {
    const rows = mapTbankOperations([buyWithTwoTrades()], '2000000001', instruments);

    expect(rows[0].ticker).toBe('SBER');
    expect(rows[0].identifiers).toEqual({ isin: 'RU0009029540', figi: 'BBG004730N88', tbankUid: 'uid-sber' });
  });

  it('«ISIN» брокера, не прошедший проверку (TCS00A10B4K3), — brokerCode, а не isin', () => {
    const tcs = new Map([
      ['uid-sber', { ticker: 'TCS00A10B4K3', isin: 'TCS00A10B4K3', name: 'Норникель БО', instrumentType: 'bond' }],
    ]);
    const rows = mapTbankOperations([buyWithTwoTrades()], '2000000001', tcs);

    expect(rows[0].identifiers?.isin).toBeUndefined();
    expect(rows[0].identifiers?.brokerCode).toBe('TCS00A10B4K3');
  });
});

describe('mapTbankOperations — комиссия отдельной операцией (BROKER_FEE)', () => {
  const fee = (id: string, parent: string | undefined, amount: number): TbankOperationItem => ({
    id,
    parentOperationId: parent,
    date: '2026-03-15T10:30:00Z',
    type: 'OPERATION_TYPE_BROKER_FEE',
    state: 'OPERATION_STATE_EXECUTED',
    payment: { currency: 'rub', units: String(-amount), nano: 0 },
  });

  it('прибавляется к комиссии родительской сделки, распределяясь по её исполнениям; отдельной строки нет', () => {
    const rows = mapTbankOperations([buyWithTwoTrades(), fee('fee-1', 'op-1', 1.3)], 'acc', instruments);
    expect(rows.every((r) => r.tradeType !== 'fee')).toBe(true);
    const total = rows.reduce((s, r) => s.plus(r.fee ?? '0'), new Decimal(0));
    expect(total.toString()).toBe('10'); // 8.7 + 1.3
  });

  it('без родителя в выборке остаётся обычной комиссией', () => {
    const rows = mapTbankOperations([fee('fee-2', 'нет-такой', 5)], 'acc', instruments);
    expect(rows).toHaveLength(1);
    expect(rows[0].tradeType).toBe('fee');
  });
});

describe('дедупликация с файловым импортом', () => {
  /** Строка так, как её отдаёт XLSX-парсер отчёта Т-Банка (brokerRef = «Номер сделки») */
  const fromXlsx: RawRow = {
    date: '15.03.2026',
    ticker: 'SBER',
    name: 'Сбербанк России',
    instrumentType: 'Stock',
    currency: 'RUB',
    tradeType: 'Покупка',
    quantity: '60',
    price: '300',
    fee: '5.22',
    note: 'Сделка № 4000000001',
    brokerRef: '4000000001',
  };

  it('сделка из API и та же сделка из XLSX дают одинаковый ключ дедупликации', () => {
    const [fromApi] = mapTbankOperations([buyWithTwoTrades()], '2000000001', instruments);
    const resolvers = {
      resolveSystem: () => 'sys',
      resolvePortfolio: () => 'pf',
      resolveInstrument: () => ({ instrumentId: 'SBER' }),
    };

    const api = normalizeRow(fromApi, resolvers);
    const xlsx = normalizeRow(fromXlsx, resolvers);
    expect('error' in api).toBe(false);
    expect('error' in xlsx).toBe(false);

    const apiKey = makeDedupeKey((api as { operation: never }).operation);
    const xlsxKey = makeDedupeKey((xlsx as { operation: never }).operation);
    expect(apiKey).toBe(xlsxKey);
    expect(apiKey).toBe('ref:4000000001');
  });

  it('разные исполнения одной заявки не схлопываются в дубль', () => {
    const rows = mapTbankOperations([buyWithTwoTrades()], '2000000001', instruments);
    const resolvers = {
      resolveSystem: () => 'sys',
      resolvePortfolio: () => 'pf',
      resolveInstrument: () => ({ instrumentId: 'SBER' }),
    };
    const keys = rows.map((r) => {
      const res = normalizeRow(r, resolvers);
      return makeDedupeKey((res as { operation: never }).operation);
    });

    expect(new Set(keys).size).toBe(2);
  });
});
