import { describe, expect, it } from 'vitest';
import { identityConflicts } from './identity-conflicts';

// Наборы кодов — из реальной БД (выгрузка instrument_identifiers, 2026-11-09)
const e = (scheme: string, value: string) => ({ scheme, value });

describe('identityConflicts', () => {
  it('CNYRUB_TOM + GLDRUB_TOM: два биржевых тикера — пометка', () => {
    const r = identityConflicts([
      e('ticker', 'GLDRUB_TOM'),
      e('ticker', 'CNYRUB_TOM'),
      e('name', 'cnyrub_tom'),
      e('name', 'китайский юань'),
      e('tbank_uid', '6e9d40d6-201f-45ac-9833-18dd40a09d33'),
      e('figi', 'BBG0013HRTL0'),
    ]);
    expect(r).toEqual({ conflicting: true, tickers: ['CNYRUB_TOM', 'GLDRUB_TOM'] });
  });

  it('RU000A10B4K3 + TCS00A10B4K3: оба кода формы ISIN — нет пометки', () => {
    const r = identityConflicts([
      e('ticker', 'RU000A10B4K3'),
      e('isin', 'RU000A10B4K3'),
      e('ticker', 'TCS00A10B4K3'),
      e('figi', 'TCS00A10B4K3'),
      e('tbank_uid', 'b0d398e6-6616-4c3f-b3b9-6929f5545c78'),
    ]);
    expect(r.conflicting).toBe(false);
    expect(r.tickers).toEqual([]);
  });

  it('два tbank_uid у одного инструмента — нет пометки (figi/uid в правиле не участвуют)', () => {
    const r = identityConflicts([
      e('ticker', 'RU000A10B4K3'),
      e('tbank_uid', 'b0d398e6-6616-4c3f-b3b9-6929f5545c78'),
      e('tbank_uid', '6e46d84f-5a8e-4297-a942-a16ab34cc262'),
    ]);
    expect(r.conflicting).toBe(false);
  });

  it('разные figi при одном тикере — нет пометки', () => {
    expect(identityConflicts([e('ticker', 'TMON'), e('figi', 'AAA'), e('figi', 'BBB')]).conflicting).toBe(false);
  });

  it('TMON + «денежный рынок» (название) — нет пометки', () => {
    expect(identityConflicts([e('ticker', 'TMON'), e('name', 'денежный рынок'), e('isin', 'RU000A106DL2')]).conflicting).toBe(false);
  });

  it('один тикер, повторённый в разном регистре, — не конфликт', () => {
    expect(identityConflicts([e('ticker', 'SBER'), e('ticker', 'sber')]).conflicting).toBe(false);
  });

  it('пустой набор', () => {
    expect(identityConflicts([])).toEqual({ conflicting: false, tickers: [] });
  });
});
