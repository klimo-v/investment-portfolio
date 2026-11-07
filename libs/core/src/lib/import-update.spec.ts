import { describe, expect, it } from 'vitest';
import { attachParentFees, mergeBrokerFields, type RawRow } from './import';

const trade = (over: Partial<RawRow> = {}): RawRow => ({
  date: '2026-11-05',
  tradeType: 'Buy',
  ticker: 'SBER',
  quantity: '10',
  price: '100',
  fee: '0',
  brokerRef: 'T1',
  ...over,
});
const feeRow = (parent: string, amount: string, ref: string): RawRow => ({
  date: '2026-11-05',
  tradeType: 'Fee',
  quantity: '1',
  price: amount,
  fee: amount,
  brokerRef: ref,
  parentBrokerRef: parent,
});

describe('attachParentFees', () => {
  it('комиссия отдельной строкой по ссылке прибавляется к родителю, строка комиссии исчезает', () => {
    const rows = attachParentFees([trade({ fee: '1.5' }), feeRow('T1', '2.5', 'F1')]);
    expect(rows).toHaveLength(1);
    expect(rows[0].fee).toBe('4');
  });

  it('несколько комиссий на одну сделку суммируются, чужие сделки не затрагиваются', () => {
    const rows = attachParentFees([
      trade(),
      trade({ brokerRef: 'T2', fee: '7' }),
      feeRow('T1', '1.25', 'F1'),
      feeRow('T1', '0.75', 'F2'),
    ]);
    expect(rows.map((r) => [r.brokerRef, r.fee])).toEqual([
      ['T1', '2'],
      ['T2', '7'],
    ]);
  });

  it('идемпотентно: тот же набор строк даёт то же fee', () => {
    const input = [trade({ fee: '1' }), feeRow('T1', '2', 'F1')];
    expect(attachParentFees(input)[0].fee).toBe('3');
    expect(attachParentFees(input)[0].fee).toBe('3');
    expect(input[0].fee).toBe('1'); // входные строки не мутируются
  });

  it('родителя нет в загрузке — строка остаётся обычной комиссией (вслепую не прибавляем)', () => {
    const rows = attachParentFees([feeRow('NOPE', '2', 'F1')]);
    expect(rows).toHaveLength(1);
    expect(rows[0].parentBrokerRef).toBe('NOPE');
  });

  it('сумма берётся из price × quantity, если колонки fee нет', () => {
    const f: RawRow = { ...feeRow('T1', '3', 'F1'), fee: undefined };
    expect(attachParentFees([trade(), f])[0].fee).toBe('3');
  });
});

describe('mergeBrokerFields', () => {
  const existing = { fee: '1.5', price: '100', quantity: '10', executedAt: '10:00:00' };

  it('полное совпадение — изменений нет', () => {
    expect(mergeBrokerFields(existing, { ...existing })).toEqual([]);
    expect(mergeBrokerFields(existing, { ...existing, fee: '1.50', price: '100.0' })).toEqual([]);
  });

  it('изменённая комиссия — update с диффом «было → станет»', () => {
    expect(mergeBrokerFields(existing, { ...existing, fee: '7.40' })).toEqual([
      { field: 'fee', from: '1.5', to: '7.40' },
    ]);
  });

  it('нулевая комиссия не затирает известную', () => {
    expect(mergeBrokerFields(existing, { ...existing, fee: '0' })).toEqual([]);
  });

  it('комиссия «приехала позже»: было 0 → стало положительное', () => {
    expect(mergeBrokerFields({ ...existing, fee: '0' }, { ...existing, fee: '4.81' })).toEqual([
      { field: 'fee', from: '0', to: '4.81' },
    ]);
  });

  it('цена, количество и время — брокер прав; пустое время существующее не стирает', () => {
    const changes = mergeBrokerFields(existing, { fee: '1.5', price: '101', quantity: '9', executedAt: '10:00:05' });
    expect(changes.map((c) => c.field)).toEqual(['price', 'quantity', 'executedAt']);
    expect(mergeBrokerFields(existing, { ...existing, executedAt: null })).toEqual([]);
  });

  it('аннотации (CSV QUIK) не меняют ни одного поля операции', () => {
    expect(mergeBrokerFields(existing, { fee: '19.54', price: '1', quantity: '1', executedAt: '01:00:00' }, 'annotation')).toEqual([]);
  });
});
