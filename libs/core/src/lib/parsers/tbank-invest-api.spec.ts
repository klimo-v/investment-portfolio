import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  mapTbankOperations,
  moneyToDecimal,
  type TbankInstrumentRef,
  type TbankMoneyValue,
  type TbankOperationItem,
} from './tbank-invest-api';
import { makeDedupeKey, normalizeRow, type RawRow } from '../import';
import { sourceCodeOf } from '../instrument-identity';

/**
 * Тесты маппера T-Invest API. Фикстуры синтетические (реальные ответы содержат
 * номера счетов и ПДн), но структура и цифры — как в настоящих ответах брокера.
 * Приоритет — денежная арифметика и дедупликация (CLAUDE.md §10).
 */

function money(amount: string, currency = 'rub'): TbankMoneyValue {
  const decimal = new Decimal(amount);
  return {
    currency,
    units: decimal.trunc().toFixed(),
    nano: decimal.minus(decimal.trunc()).mul(1_000_000_000).toNumber(),
  };
}

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
    expect(rows.every((r) => r.grossTradeAmountIssue === undefined)).toBe(true);
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

  it('корректировка налога: зачисление — возврат (отрицательный Tax), списание — удержание', () => {
    const correction = (id: string, units: string): TbankOperationItem => ({
      id,
      date: '2025-05-06T00:00:00Z',
      type: 'OPERATION_TYPE_TAX_CORRECTION',
      description: 'Корректировка налога',
      state: 'OPERATION_STATE_EXECUTED',
      payment: { currency: 'rub', units, nano: 0 },
    });
    const rows = mapTbankOperations(
      [correction('tc-refund', '2689'), correction('tc-withhold', '-2689')],
      '2000000001',
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ tradeType: 'tax', price: '-2689' });
    expect(rows[0].note).toContain('возврат');
    expect(rows[1]).toMatchObject({ tradeType: 'tax', price: '2689' });
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

  it('незнакомый тип операции не превращается в покупку: normalizeRow возвращает ошибку', () => {
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
    expect('error' in normalized).toBe(true);
    expect((normalized as { error: string }).error).toContain('Неизвестный тип');
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

describe('mapTbankOperations — комиссия: одно списание — одна запись (П1)', () => {
  const fee = (id: string, parent: string | undefined, amount: number): TbankOperationItem => ({
    id,
    parentOperationId: parent,
    date: '2026-03-15T10:30:00Z',
    type: 'OPERATION_TYPE_BROKER_FEE',
    state: 'OPERATION_STATE_EXECUTED',
    payment: money(String(-amount)),
  });
  const totalFee = (rows: RawRow[]) => rows.reduce((sum, r) => sum.plus(r.fee ?? '0'), new Decimal(0)).toString();

  it('commission равна сумме дочерних BROKER_FEE (реальный случай) — комиссия одна, не удвоенная', () => {
    // реальный пример: GAZP, комиссия 20,23 пришла и полем commission, и дочерней BROKER_FEE
    const op: TbankOperationItem = {
      ...buyWithTwoTrades(),
      tradesInfo: undefined,
      commission: { currency: 'rub', units: '-20', nano: -230000000 },
    };
    const rows = mapTbankOperations([op, fee('fee-1', 'op-1', 20.23)], 'acc', instruments);
    expect(rows).toHaveLength(1);
    expect(rows[0].fee).toBe('20.23');
  });

  it('несколько исполнений: комиссия делится по сделкам, сумма равна комиссии (8,7, а не 17,4)', () => {
    const rows = mapTbankOperations([buyWithTwoTrades(), fee('fee-1', 'op-1', 8.7)], 'acc', instruments);
    expect(rows.every((r) => r.tradeType !== 'fee')).toBe(true);
    expect(totalFee(rows)).toBe('8.7');
  });

  it('только commission (дочерней нет)', () => {
    expect(totalFee(mapTbankOperations([buyWithTwoTrades()], 'acc', instruments))).toBe('8.7');
  });

  it('только дочерняя BROKER_FEE (commission пуста)', () => {
    const op: TbankOperationItem = { ...buyWithTwoTrades(), commission: undefined };
    expect(totalFee(mapTbankOperations([op, fee('fee-1', 'op-1', 1.3)], 'acc', instruments))).toBe('1.3');
  });

  it('без родителя в выборке остаётся обычной комиссией (Fee)', () => {
    const rows = mapTbankOperations([fee('fee-2', 'нет-такой', 5)], 'acc', instruments);
    expect(rows).toHaveLength(1);
    expect(rows[0].tradeType).toBe('fee');
    expect(rows[0].price).toBe('5');
  });

  it('абонентская плата 390 — отдельная Fee', () => {
    const svc: TbankOperationItem = {
      id: 'svc',
      date: '2026-07-22T04:00:00Z',
      type: 'OPERATION_TYPE_SERVICE_FEE',
      description: 'Списание комиссии за обслуживание',
      state: 'OPERATION_STATE_EXECUTED',
      payment: { currency: 'rub', units: '-390', nano: 0 },
    };
    const [row] = mapTbankOperations([svc], 'acc', instruments);
    expect(row.tradeType).toBe('fee');
    expect(row.price).toBe('390');
  });

  it('возврат комиссии (payment > 0) — Fee с отрицательной суммой', () => {
    const refund: TbankOperationItem = { ...fee('fee-r', undefined, 0), payment: { currency: 'rub', units: '7', nano: 0 } };
    const [row] = mapTbankOperations([refund], 'acc', instruments);
    expect(row.tradeType).toBe('fee');
    expect(row.price).toBe('-7');
  });
});

describe('mapTbankOperations — знак задаёт брокер (П2), время (П5), дивиденд на карту', () => {
  const pay = (type: string, units: string, extra: Partial<TbankOperationItem> = {}): TbankOperationItem => ({
    id: `id-${type}-${units}`,
    date: '2026-03-15T10:30:00Z',
    type: `OPERATION_TYPE_${type}`,
    state: 'OPERATION_STATE_EXECUTED',
    payment: { currency: 'rub', units, nano: 0 },
    ...extra,
  });
  const price = (item: TbankOperationItem) => mapTbankOperations([item], 'acc', instruments)[0].price;

  it('расходы пишутся положительно, возврат — отрицательно; доходы — со своим знаком', () => {
    expect(price(pay('TAX', '-100'))).toBe('100');
    expect(price(pay('TAX_CORRECTION', '100'))).toBe('-100');
    expect(price(pay('TAX_CORRECTION_PROGRESSIVE', '100'))).toBe('-100');
    expect(price(pay('TAX_REPO_REFUND', '50'))).toBe('-50');
    expect(price(pay('OUTPUT', '-500'))).toBe('500');
    expect(price(pay('INPUT', '500'))).toBe('500');
    expect(price(pay('DIVIDEND', '1000'))).toBe('1000');
  });

  it('сторно дивиденда (payment < 0) — Dividend с отрицательной суммой', () => {
    expect(price(pay('DIVIDEND', '-1000'))).toBe('-1000');
  });

  it('налог со ссылкой на выплату вычитается из неё один раз; возврат налога прибавляется', () => {
    const div = pay('DIVIDEND', '1000', { id: 'div', instrumentUid: 'uid-sber' });
    const tax = pay('DIVIDEND_TAX', '-130', { id: 't', parentOperationId: 'div', instrumentUid: 'uid-sber' });
    const rows = mapTbankOperations([div, tax], 'acc', instruments);
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe('870');
    const back = pay('DIVIDEND_TAX', '30', { id: 't2', parentOperationId: 'div', instrumentUid: 'uid-sber' });
    expect(mapTbankOperations([div, tax, back], 'acc', instruments)[0].price).toBe('900');
  });

  it('время — по Москве из метки UTC, для сделок и выплат', () => {
    const rows = mapTbankOperations([buyWithTwoTrades(), pay('TAX', '-1')], 'acc', instruments);
    expect(rows.every((r) => /^\d{2}:\d{2}:\d{2}$/.test(r.time ?? ''))).toBe(true); // у каждой строки есть время
    expect(rows[0].time).toBe('13:30:00');
    const [n] = mapTbankOperations([pay('INPUT', '1', { date: '2026-03-15T21:05:07Z' })], 'acc', instruments);
    expect(n.time).toBe('00:05:07');
  });

  it('DIV_EXT: Dividend (брутто) + Withdraw (брутто − налог), налог остаётся Tax; кэш от трёх записей — ноль', () => {
    const ext = pay('DIV_EXT', '16928', { id: 'ext', instrumentUid: 'uid-sber', description: 'Выплата дивидендов на карту' });
    const tax = pay('DIVIDEND_TAX', '-2200', { id: 'tx', instrumentUid: 'uid-sber' });
    const rows = mapTbankOperations([ext, tax], 'acc', instruments);
    const div = rows.find((r) => r.tradeType === 'dividend');
    const wd = rows.find((r) => r.tradeType === 'withdraw');
    const tx = rows.find((r) => r.tradeType === 'tax');
    expect(rows).toHaveLength(3);
    expect(div?.price).toBe('16928');
    expect(div?.ticker).toBe('SBER');
    expect(wd?.price).toBe('14728');
    expect(wd?.ticker).toBeUndefined();
    expect(wd?.brokerRef).toBe('ext:card');
    expect(div?.transferGroup).toBe('divext:ext');
    expect(wd?.transferGroup).toBe('divext:ext');
    expect(tx?.price).toBe('2200');
    const cash = new Decimal(div!.price!).minus(tx!.price!).minus(wd!.price!);
    expect(cash.toString()).toBe('0');
  });

  it('DIV_EXT и обычный дивиденд в один день: налог делится пропорционально выплатам', () => {
    const ext = pay('DIV_EXT', '1000', { id: 'ext', instrumentUid: 'uid-sber' });
    const div = pay('DIVIDEND', '3000', { id: 'div', instrumentUid: 'uid-sber' });
    const tax = pay('DIVIDEND_TAX', '-520', { id: 'tx', instrumentUid: 'uid-sber' });
    const wd = mapTbankOperations([ext, div, tax], 'acc', instruments).find((r) => r.tradeType === 'withdraw');
    expect(wd?.price).toBe('870'); // 1000 − 520 × 1000/4000
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

describe('происхождение операции (sourceCode)', () => {
  it('API: строка получает самый сильный код — tbank_uid инструмента', () => {
    const rows = mapTbankOperations([buyWithTwoTrades()], 'acc-1', instruments);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(sourceCodeOf(r)).toMatch(/^(tbank_uid|figi|isin|ticker):/);
    const res = normalizeRow(rows[0], { resolveSystem: () => 's', resolvePortfolio: () => 'p', resolveInstrument: (r: RawRow) => ({ instrumentId: r.ticker ?? null }) });
    expect('operation' in res && res.operation.sourceCode).toBeTruthy();
  });
});

describe('подтверждённая сумма исполнения покупки облигации', () => {
  const date = '2026-07-06T08:00:00Z';
  function bondBuy(quantities: number[]): TbankOperationItem {
    const done = quantities.reduce((sum, qty) => sum + qty, 0);
    const price = '101.237';
    const payment = quantities.reduce((sum, qty) =>
      sum.plus(new Decimal(price).mul(qty).toDecimalPlaces(2)).plus(new Decimal('2.43').mul(qty)),
    new Decimal(0));
    return {
      id: 'parent',
      type: 'OPERATION_TYPE_BUY',
      state: 'OPERATION_STATE_EXECUTED',
      instrumentType: 'bond',
      date,
      quantity: '30',
      quantityDone: String(done),
      payment: money(payment.neg().toFixed()),
      price: money(price),
      accruedInt: money(new Decimal('2.43').mul(done).toFixed()),
      commission: money('-3.17'),
      tradesInfo: {
        trades: quantities.map((qty, i) => ({
          num: 'fill-' + i, date, quantity: String(qty), price: money(price),
        })),
      },
    };
  }

  it('использует payment по исполненным 7 из 30 бумаг и учитывает дочернюю комиссию ровно один раз', () => {
    const item = bondBuy([7]);
    const child: TbankOperationItem = {
      type: 'OPERATION_TYPE_BROKER_FEE', state: item.state, parentOperationId: item.id,
      payment: money('-3.17'),
    };
    const rows = mapTbankOperations([item, child], 'account');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      quantity: '7', executionRef: 'fill-0', price: '101.237', fee: '3.17',
      grossTradeAmount: '725.67', grossTradeAmountSource: 'tbank-payment',
    });
  });

  it('сверяет все 23 июльских исполнения с суммами брокера до копейки', () => {
    // Числовые поля 14 операций GetOperationsByCursor; в последней заявке исполнено 7 из 30.
    // Суммы отдельных исполнений в последней колонке взяты из независимой сверки.
    const groups: [price: string, accrued: string, payment: string, qty: number[], expected: string[]][] = [
      ['1325.00973', '364.4', '-26864.59', [20], ['26864.59']],
      ['1032.45', '847.2', '-21496.2', [20], ['21496.2']],
      ['1584.983618', '367.2', '-32066.87', [20], ['32066.87']],
      ['1030.55', '847.2', '-21458.2', [7, 12, 1], ['7510.37', '12874.92', '1072.91']],
      ['981.100294', '105.5', '-24633.01', [25], ['24633.01']],
      ['1324.59549', '364.4', '-26856.31', [20], ['26856.31']],
      ['993.85', '590.2', '-20467.2', [5, 2, 2, 1, 1, 6, 3],
        ['5116.8', '2046.72', '2046.72', '1023.36', '1023.36', '6140.16', '3070.08']],
      ['993.51', '747.5', '-25585.25', [25], ['25585.25']],
      ['993.53', '1495', '-51171.5', [50], ['51171.5']],
      ['992.74', '1534', '-51171', [50], ['51171']],
      ['993', '920.4', '-30710.4', [28, 2], ['28663.04', '2047.36']],
      ['993', '935.25', '-29732.25', [29], ['29732.25']],
      ['1586.7908', '598.2', '-48201.92', [30], ['48201.92']],
      ['1581.53072', '139.58', '-11210.3', [7], ['11210.3']],
    ];
    let gross = new Decimal(0);
    let delta = new Decimal(0);
    for (const [price, accrued, payment, qty, expected] of groups) {
      const item = bondBuy(qty);
      item.payment = money(payment);
      item.accruedInt = money(accrued);
      item.quantity = qty.length === 1 && qty[0] === 7 ? '30' : item.quantityDone;
      for (const fill of item.tradesInfo!.trades!) fill.price = money(price);
      const rows = mapTbankOperations([item], 'account');
      expect(rows.map(r => r.grossTradeAmount)).toEqual(expected);
      for (const row of rows) {
        expect(row.grossTradeAmountSource).toBe(qty.length === 1 ? 'tbank-payment' : 'tbank-reconciled');
        gross = gross.plus(row.grossTradeAmount!);
        delta = delta.plus(row.grossTradeAmount!).minus(new Decimal(row.quantity!).mul(row.price!));
      }
    }
    expect(gross.toFixed(2)).toBe('421625.00');
    expect(delta.toFixed(6)).toBe('9856.026850');
  });

  it('не подставляет родительский ID за отсутствующий биржевой номер', () => {
    const item = bondBuy([2, 3]);
    delete item.tradesInfo!.trades![0].num;
    const rows = mapTbankOperations([item], 'account');
    expect(rows[0]).toMatchObject({ brokerRef: 'parent', grossTradeAmountIssue: expect.stringContaining('номера') });
    expect(rows[0].executionRef).toBeUndefined();
    expect(rows.every((row) => row.skipReason?.includes('номера'))).toBe(true);
    expect(rows.every((row) => row.grossTradeAmount === undefined)).toBe(true);
  });

  it.each([
    ['неполная группа', (item: TbankOperationItem) => item.tradesInfo!.trades!.pop(), /quantityDone/],
    ['остаточная копейка', (item: TbankOperationItem) => { item.payment = money(moneyToDecimal(item.payment).minus('0.01').toFixed()); }, /расходится/],
    ['повторный номер', (item: TbankOperationItem) => { item.tradesInfo!.trades![1].num = 'fill-0'; }, /повторяются/],
    ['пропавший НКД', (item: TbankOperationItem) => { delete item.accruedInt; }, /нет НКД/],
    ['чужая валюта НКД', (item: TbankOperationItem) => { item.accruedInt!.currency = 'usd'; }, /Валюта НКД/],
    ['чужая валюта цены', (item: TbankOperationItem) => { item.tradesInfo!.trades![1].price!.currency = 'usd'; }, /Валюта цены/],
    ['чужая валюта комиссии', (item: TbankOperationItem) => { item.commission!.currency = 'usd'; }, /Валюта комиссии/],
    ['пустой платёж', (item: TbankOperationItem) => { item.payment = { currency: 'rub' }; }, /Некорректный платёж/],
    ['продажа', (item: TbankOperationItem) => { item.type = 'OPERATION_TYPE_SELL'; item.payment = money('518.34'); }, /состав сделки продажи/],
  ] as const)('оставляет сумму неизвестной: %s', (_, change, issue) => {
    const item = bondBuy([2, 3]);
    change(item);
    const rows = mapTbankOperations([item], 'account');
    for (const row of rows) {
      expect(row.grossTradeAmount).toBeUndefined();
      expect(row.grossTradeAmountSource).toBeUndefined();
      expect(row.grossTradeAmountIssue).toMatch(issue);
    }
  });
});
