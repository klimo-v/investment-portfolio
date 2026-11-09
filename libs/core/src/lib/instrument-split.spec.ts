import { describe, expect, it } from 'vitest';
import { planInstrumentSplit, SplitRequestSchema, type SplitInput } from './instrument-split';
import type { Operation } from './schemas';

const op = (id: string, p: Partial<Operation>): Operation => ({
  id,
  date: '2024-08-01',
  systemId: 's',
  portfolioId: 'p',
  instrumentId: 'GLD',
  operationType: 'Buy',
  quantity: '10',
  price: '12',
  fee: '0',
  fxRate: '1',
  currency: 'RUB',
  ...p,
});

const ops = [
  op('b1', { quantity: '4226', price: '11.78' }),
  op('b2', { quantity: '15634', price: '12.1' }),
  op('s1', { date: '2024-09-04', operationType: 'Sell', quantity: '19860', price: '12.8' }),
];
const codes = [
  { scheme: 'ticker', value: 'GLDRUB_TOM', origin: 'import', createdAt: '2026-11-07 21:24:55' },
  { scheme: 'ticker', value: 'CNYRUB_TOM', origin: 'merge', createdAt: '2026-11-07 21:24:55' },
  { scheme: 'figi', value: 'BBG0013HRTL0', origin: 'merge', createdAt: '2026-11-08 10:31:40' },
];

const base = (over: Partial<SplitInput['request']> = {}): SplitInput => ({
  instrumentId: 'GLD',
  operations: ops,
  identifiers: codes,
  takenInstrumentIds: new Set(['GLD']),
  takenIdentifierKeys: new Set(codes.map((c) => `${c.scheme}:${c.value}`)),
  request: SplitRequestSchema.parse({
    newInstrument: { id: 'CNY', ticker: 'CNYRUB_TOM', type: 'Currency', currency: 'RUB', name: 'Китайский юань', marketSource: 'moex' },
    operationIds: ['b1', 'b2', 's1'],
    identifierKeys: ['ticker:CNYRUB_TOM', 'figi:BBG0013HRTL0'],
    ...over,
  }),
});

describe('planInstrumentSplit', () => {
  it('сценарий CNY/GLD: все операции и коды юаня уходят в новый инструмент', () => {
    const plan = planInstrumentSplit(base());
    expect(plan.errors).toEqual([]);
    expect(plan.movedOperationIds).toEqual(['b1', 'b2', 's1']);
    expect(plan.movedIdentifiers.map((e) => e.value)).toEqual(['CNYRUB_TOM', 'BBG0013HRTL0']);
    expect(plan.remainingIdentifiers.map((e) => e.value)).toEqual(['GLDRUB_TOM']);
    expect(plan.preview.before.positions).toEqual([]); // купили и продали всё
    expect(plan.preview.created.positions).toEqual([]);
    expect(plan.preview.remaining.operations).toBe(0);
  });

  it('предпросмотр: количество и средняя цена до и после при частичном выборе', () => {
    const plan = planInstrumentSplit(base({ operationIds: ['b1'], identifierKeys: [] }));
    expect(plan.preview.created.positions).toEqual([{ systemId: 's', portfolioId: 'p', quantity: '4226', avgBuyPrice: '11.78000000' }]);
    expect(plan.preview.remaining.operations).toBe(2);
    // новый инструмент получает собственные тикер и название, если их никто не держит
    expect(plan.warnings.some((w) => w.includes('ticker:CNYRUB_TOM'))).toBe(true);
  });

  it('продажа без позиции после разделения — предупреждение', () => {
    const plan = planInstrumentSplit(base({ operationIds: ['s1'], identifierKeys: [] }));
    expect(plan.warnings.some((w) => w.includes('продажи без позиции'))).toBe(true);
    expect(plan.preview.created.orphanSells).toBe(1);
  });

  it('ошибки: занятый id, чужая операция, пустой выбор, чужой код', () => {
    expect(planInstrumentSplit({ ...base(), takenInstrumentIds: new Set(['GLD', 'CNY']) }).errors[0]).toMatch(/занят/);
    expect(planInstrumentSplit(base({ operationIds: ['zzz'] })).errors.join()).toMatch(/не принадлежат/);
    expect(planInstrumentSplit(base({ operationIds: [] })).errors.join()).toMatch(/Не выбрано/);
    expect(planInstrumentSplit(base({ identifierKeys: ['ticker:NOPE'] })).errors.join()).toMatch(/Коды не принадлежат/);
  });

  it('собственные тикер и название нового инструмента добавляются, если свободны', () => {
    const plan = planInstrumentSplit({ ...base({ identifierKeys: [] }), takenIdentifierKeys: new Set(['ticker:GLDRUB_TOM']) });
    expect(plan.addedIdentifiers).toEqual([
      { scheme: 'ticker', value: 'CNYRUB_TOM' },
      { scheme: 'name', value: 'китайский юань' },
    ]);
  });
});
