import { describe, expect, it } from 'vitest';
import { mergeChecks, medianPriceRatio, type MergeCheckContext, type MergeCheckInstrument } from './merge-checks';

const inst = (id: string, ticker: string, entries: [string, string][] = [], isin?: string): MergeCheckInstrument => ({
  id,
  ticker,
  isin,
  entries: [['ticker', ticker], ...entries].map(([scheme, value]) => ({ scheme, value })),
});
const none: MergeCheckContext = { sourceOps: [], targetPrices: [] };

describe('mergeChecks', () => {
  it('CNYRUB_TOM → GLDRUB_TOM: блокировка (разная база), цены тоже расходятся', () => {
    const r = mergeChecks(inst('CNYRUB_TOM', 'CNYRUB_TOM'), inst('GLDRUB_TOM', 'GLDRUB_TOM'), {
      sourceOps: [{ date: '2024-08-01', price: '11.78', currency: 'RUB' }, { date: '2024-09-04', price: '12.8', currency: 'RUB' }],
      targetPrices: [{ date: '2024-07-30', price: '8102', currency: 'RUB' }],
    });
    expect(r.blockers.map((b) => b.code)).toEqual(['currency-pair-mismatch']);
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['ticker-conflict', 'price-divergence']));
  });

  it('валютные пары с одной базой не блокируются (TOM/TOD)', () => {
    expect(mergeChecks(inst('a', 'CNYRUB_TOD'), inst('b', 'CNYRUB_TOM'), none).blockers).toEqual([]);
  });

  it('TMON@ → TMON: проходит без предупреждений', () => {
    const r = mergeChecks(inst('s', 'TMON@', [['name', 'денежный рынок']]), inst('t', 'TMON', [['isin', 'RU000A106DL2']], 'RU000A106DL2'), none);
    expect(r).toEqual({ blockers: [], warnings: [] });
  });

  it('TCS00A10B4K3 → RU000A10B4K3: проходит (TCS00… не валидный ISIN, тикеры формы ISIN)', () => {
    const r = mergeChecks(
      inst('s', 'TCS00A10B4K3', [['figi', 'TCS00A10B4K3']]),
      inst('t', 'RU000A10B4K3', [['isin', 'RU000A10B4K3'], ['tbank_uid', 'x'], ['tbank_uid', 'y']], 'RU000A10B4K3'),
      none,
    );
    expect(r).toEqual({ blockers: [], warnings: [] });
  });

  it('разные валидные ISIN → предупреждение', () => {
    const r = mergeChecks(inst('s', 'RU000A106DL2', [], 'RU000A106DL2'), inst('t', 'RU0009029540', [], 'RU0009029540'), none);
    expect(r.warnings.map((w) => w.code)).toContain('different-isin');
    expect(r.blockers).toEqual([]);
  });

  it('разные биржевые тикеры → предупреждение ticker-conflict', () => {
    expect(mergeChecks(inst('s', 'SBERP'), inst('t', 'SBER'), none).warnings.map((w) => w.code)).toEqual(['ticker-conflict']);
  });

  it('USD-облигация: валюта операции ≠ валюта цены — проверка цены пропускается', () => {
    const r = mergeChecks(inst('s', 'TCS00X'), inst('t', 'RU000A10B4K3'), {
      sourceOps: [{ date: '2025-01-10', price: '84', currency: 'RUB' }],
      targetPrices: [{ date: '2025-01-09', price: '1', currency: 'USD' }],
    });
    expect(r.warnings.map((w) => w.code)).not.toContain('price-divergence');
  });

  it('нет цен — проверка цены пропускается; нормальная медиана — без предупреждения', () => {
    expect(medianPriceRatio(none)).toBeNull();
    const ctx: MergeCheckContext = {
      sourceOps: [{ date: '2025-01-10', price: '101', currency: 'RUB' }, { date: '2025-02-10', price: '99', currency: 'RUB' }],
      targetPrices: [{ date: '2025-01-09', price: '100', currency: 'RUB' }, { date: '2025-02-09', price: '100', currency: 'RUB' }],
    };
    expect(medianPriceRatio(ctx)).toBeCloseTo(1, 1);
    expect(mergeChecks(inst('s', 'A'), inst('t', 'A'), ctx).warnings).toEqual([]);
  });

  it('операции раньше истории цен цели пропускаются (цена другой эпохи — не повод для предупреждения)', () => {
    const ctx: MergeCheckContext = {
      sourceOps: [{ date: '2020-01-10', price: '10', currency: 'RUB' }],
      targetPrices: [{ date: '2025-01-09', price: '100', currency: 'RUB' }],
    };
    expect(medianPriceRatio(ctx)).toBeNull();
  });
});
