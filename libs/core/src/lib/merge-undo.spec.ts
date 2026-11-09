import { describe, expect, it } from 'vitest';
import type { MergePayload } from './instrument-history';
import { planMergeUndo, type MergeUndoInput } from './merge-undo';

const payload: MergePayload = {
  version: 1,
  source: { id: 'OLD', ticker: 'TCS00X', type: 'Bond', currency: 'RUB', isin: null, name: null, marketSource: 'moex' },
  targetFilled: {},
  sourceQuote: null,
  movedOperationIds: ['o1'],
  sourcePrices: [],
  pricesTransferred: true,
  targetPricesOverwritten: [],
  targetPricesInserted: [],
  settlementsMoved: [],
  settlementsLost: [],
  sourceIdentifiers: [{ scheme: 'figi', value: 'F-OLD', origin: 'import', createdAt: '2025-01-01 00:00:00' }],
  addedIdentifiers: [{ scheme: 'ticker', value: 'TCS00X' }],
};
const op = (id: string, sourceCode: string | null) => ({ id, date: '2025-01-01', operationType: 'Buy', quantity: '1', price: '1', sourceCode });
const input = (over: Partial<MergeUndoInput> = {}): MergeUndoInput => ({
  event: { id: 'm1', at: '2025-06-01 10:00:00', sourceId: 'OLD', targetId: 'NEW', undone: false, payload },
  laterMerges: [],
  instrumentIds: new Set(['NEW']),
  targetOperations: [op('o1', null), op('t1', 'figi:F-NEW'), op('s1', 'figi:F-OLD'), op('x1', null), op('x2', 'figi:UNKNOWN')],
  targetIdentifiers: [
    { scheme: 'figi', value: 'F-OLD', origin: 'merge', createdAt: '2025-01-01 00:00:00' },
    { scheme: 'ticker', value: 'TCS00X', origin: 'merge', createdAt: '2025-06-01 10:00:00' },
    { scheme: 'figi', value: 'F-NEW', origin: 'import', createdAt: '2025-01-01 00:00:00' },
    { scheme: 'tbank_uid', value: 'later', origin: 'import', createdAt: '2025-07-01 00:00:00' },
  ],
  ...over,
});

describe('planMergeUndo', () => {
  it('классификация: id из снимка и код источника → источник, код цели → цель, остальные неясные', () => {
    const p = planMergeUndo(input());
    expect(p.toSource.sort()).toEqual(['o1', 's1']);
    expect(p.toTarget).toEqual(['t1']);
    expect(p.unclear.map((o) => o.id)).toEqual(['x1', 'x2']);
    expect(p.errors.join()).toMatch(/неясные/);
  });

  it('явное распределение снимает ошибку; коды после слияния остаются у цели', () => {
    const p = planMergeUndo(input({ assignments: { toSource: ['x1'], toTarget: ['x2'] } }));
    expect(p.errors).toEqual([]);
    expect(p.toSource).toContain('x1');
    expect(p.identifiersToSource.map((e) => e.value).sort()).toEqual(['F-OLD', 'TCS00X']);
    expect(p.identifiersAfterMerge.map((e) => e.value)).toEqual(['later']);
  });

  it('отказ: более позднее слияние, занятый id источника, уже отменено', () => {
    const e = (i: Partial<MergeUndoInput>) => planMergeUndo(input({ assignments: { toTarget: ['x1', 'x2'] }, ...i })).errors.join();
    expect(e({ laterMerges: [{ id: 'm2', sourceTicker: 'NEW', targetTicker: 'C' }] })).toMatch(/Сначала отмените/);
    expect(e({ instrumentIds: new Set(['NEW', 'OLD']) })).toMatch(/занят/);
    expect(e({ event: { ...input().event, undone: true } })).toMatch(/уже отменено/);
  });

  it('удалённые операции из снимка пропускаются', () => {
    const p = planMergeUndo(input({ targetOperations: [op('t1', 'figi:F-NEW')] }));
    expect(p.skippedOperations).toEqual(['o1']);
  });
});
