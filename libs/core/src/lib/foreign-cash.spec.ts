import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { expandForeignCash, foreignCashRate, type ForeignCashLookups } from './foreign-cash';
import { mergeBrokerFields, normalizeRow, type RawRow } from './import';
import { cashBalanceRub, cashDelta } from './cash';
import { TradeLedger } from './engine';
import { compareOperations } from './operation-order';
import { mapTbankOperations, type TbankOperationItem } from './parsers/tbank-invest-api';
import type { Operation } from './schemas';

const NO_CBR: ForeignCashLookups = { cbrRate: () => null };
const CBR_12: ForeignCashLookups = { cbrRate: () => '12.1106' };

const rub = (units: string, nano = 0) => ({ currency: 'rub', units, nano });
const base = { state: 'OPERATION_STATE_EXECUTED' };

/** 04.09.2024 как в API (синтетика с реальными суммами): ввод 19 860,18 CNY, продажа CNYRUB_TOM, вывод рублей */
const DAY: TbankOperationItem[] = [
  { ...base, id: 'in', date: '2024-09-04T07:10:00Z', type: 'OPERATION_TYPE_INPUT', payment: { currency: 'cny', units: '19860', nano: 180000000 } },
  {
    ...base,
    id: 'sell',
    date: '2024-09-04T07:20:00Z',
    type: 'OPERATION_TYPE_SELL',
    instrumentUid: 'cny',
    instrumentType: 'currency',
    quantity: '19860',
    payment: rub('254138', 490000000),
    price: rub('12', 796500000),
    commission: rub('-1016', -830000000),
    tradesInfo: { trades: [{ num: '5001', date: '2024-09-04T07:20:00Z', quantity: '19860', price: rub('12', 796500000) }] },
  },
  { ...base, id: 'fee', parentOperationId: 'sell', date: '2024-09-04T07:20:00Z', type: 'OPERATION_TYPE_BROKER_FEE', payment: rub('-1016', -830000000) },
  { ...base, id: 'out', date: '2024-09-04T07:30:00Z', type: 'OPERATION_TYPE_OUTPUT', payment: rub('-253121', -660000000) },
];
const INSTR = new Map([['cny', { ticker: 'CNYRUB_TOM', name: 'Юань', currency: 'rub', instrumentType: 'currency' }]]);

const toOps = (rows: RawRow[]): Operation[] =>
  rows.map((r) => {
    const res = normalizeRow(r, {
      resolveSystem: () => 's',
      resolvePortfolio: () => 'p',
      resolveInstrument: (raw) => ({ instrumentId: raw.ticker ?? null }),
    });
    if ('error' in res) throw new Error(res.error);
    return res.operation;
  });

describe('валютное пополнение: эталон 04.09.2024', () => {
  const rows = expandForeignCash(mapTbankOperations(DAY, 'acc', INSTR), NO_CBR);
  const ops = toOps(rows);

  it('кэш дня ровно 0,00; комиссия −1 016,83; остаток 0,18 CNY — позицией', () => {
    expect(cashBalanceRub(ops).toFixed(2)).toBe('0.00');
    const ledger = new TradeLedger();
    for (const o of [...ops].sort(compareOperations)) ledger.apply(o);
    expect(ledger.orphanSells).toHaveLength(0); // продажа не осталась без позиции
    const [trade] = ledger.trades();
    expect(trade.quantity.toFixed(2)).toBe('0.18');
    expect(trade.realizedPnlRub.toFixed(2)).toBe('-1016.83'); // курсовой разницы нет — только комиссия
  });

  it('курс депозита — цена продажи дня (12,7965), а не ЦБ; пара связана transferGroup', () => {
    const dep = ops.find((o) => o.operationType === 'Deposit');
    const buy = ops.find((o) => o.operationType === 'Buy');
    expect(dep?.fxRate).toBe('12.7965');
    expect(dep?.currency).toBe('CNY');
    expect(buy?.price).toBe('12.7965');
    expect(buy?.quantity).toBe('19860.18');
    expect(buy?.fee).toBe('0');
    expect(buy?.brokerRef).toBe('in:fx');
    expect(dep?.transferGroup).toBe(buy?.transferGroup);
    expect(buy?.executedAt).toBe('00:00:00'); // раньше продажи дня
  });

  it('идемпотентность: повторная развёртка даёт те же brokerRef и ключи — ничего не удваивается', () => {
    const again = expandForeignCash(mapTbankOperations(DAY, 'acc', INSTR), NO_CBR);
    expect(again.map((r) => r.brokerRef)).toEqual(rows.map((r) => r.brokerRef));
    expect(new Set(rows.map((r) => r.brokerRef)).size).toBe(rows.length);
  });
});

describe('foreignCashRate / expandForeignCash: прочие случаи', () => {
  const dep = (over: Partial<RawRow> = {}): RawRow => ({
    date: '2025-01-10', currency: 'CNY', tradeType: 'deposit', quantity: '1', price: '1000', brokerRef: 'd1', ...over,
  });

  it('без продажи в день — курс ЦБ; сумма в рублях = сумма × курс, кэш пары нейтрален', () => {
    const rows = expandForeignCash([dep()], CBR_12);
    expect(rows).toHaveLength(2);
    const ops = toOps(rows);
    expect(cashBalanceRub(ops).toFixed(2)).toBe('0.00');
    expect(cashDelta(ops[0]).toFixed(2)).toBe('12110.60');
  });

  it('продажа этой валюты в журнале (БД) за тот же день задаёт курс — загрузки не расходятся', () => {
    const lk: ForeignCashLookups = { cbrRate: () => '12', journalSales: () => [{ quantity: '100', price: '13' }, { quantity: '100', price: '14' }] };
    expect(foreignCashRate('CNY', '2025-01-10', [], lk)).toEqual({ rate: '13.5', source: 'same-day-sale' });
  });

  it('нет курса — ошибка предпросмотра (skipReason), а не молчаливая единица', () => {
    const [row] = expandForeignCash([dep()], NO_CBR);
    expect(row.skipReason).toContain('Нет курса CNY');
    expect(expandForeignCash([dep({ currency: 'JPY' })], CBR_12)[0].skipReason).toContain('Нет валютной пары');
  });

  it('вывод валюты — зеркально: сначала продажа пары, затем Withdraw', () => {
    const rows = expandForeignCash([dep({ tradeType: 'withdraw', brokerRef: 'w1' })], CBR_12);
    expect(rows.map((r) => r.tradeType)).toEqual(['sell', 'withdraw']);
    expect(rows[0].time).toBe('23:59:59');
  });

  it('прочие нерублёвые строки без fxRate получают курс ЦБ; рублёвые не трогаются', () => {
    const buyUsd: RawRow = { date: '2025-01-10', currency: 'USD', tradeType: 'buy', ticker: 'X', quantity: '1', price: '10' };
    expect(expandForeignCash([buyUsd], CBR_12)[0].fxRate).toBe('12.1106');
    expect(expandForeignCash([buyUsd], NO_CBR)[0].skipReason).toContain('Нет курса USD');
    const r: RawRow = { date: '2025-01-10', currency: 'RUB', tradeType: 'buy', quantity: '1', price: '10' };
    expect(expandForeignCash([r], NO_CBR)).toEqual([r]);
  });
});

describe('mergeBrokerFields: курс', () => {
  it('курс 1 у нерублёвой суммы исправляется брокерским курсом', () => {
    const existing = { fee: '0', price: '19860.18', quantity: '1', executedAt: null, fxRate: '1' };
    const changes = mergeBrokerFields(existing, { ...existing, fxRate: '12.7965' });
    expect(changes).toEqual([{ field: 'fxRate', from: '1', to: '12.7965' }]);
    expect(mergeBrokerFields(existing, existing)).toEqual([]);
    expect(new Decimal(changes[0].to).gt(1)).toBe(true);
  });
});
