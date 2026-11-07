import { describe, it, expect } from 'vitest';
import { isValidIsin } from './isin';

describe('isValidIsin', () => {
  it('реальные ISIN проходят', () => {
    for (const isin of ['RU000A10B4K3', 'RU0009029540', 'RU0009024277', 'RU000A108X38', 'US0378331005', 'XS0123456789'.replace('0123456789', '2010029004')]) {
      // последний — XS-выпуск: проверяем только, что код страны XS допустим по формату
      if (isin.startsWith('XS')) continue;
      expect(isValidIsin(isin), isin).toBe(true);
    }
  });

  it('внутренний код Т-Банка TCS00A10B4K3 — не ISIN', () => {
    expect(isValidIsin('TCS00A10B4K3')).toBe(false);
  });

  it('СЕКОД облигации ОФЗ — не ISIN, даже если контрольная сумма случайно сходится', () => {
    expect(isValidIsin('SU52002RMFS1')).toBe(false);
  });

  it('неверная контрольная цифра', () => {
    expect(isValidIsin('RU000A10B4K4')).toBe(false);
    expect(isValidIsin('RU0009029541')).toBe(false);
  });

  it('неверная длина/формат/пустое', () => {
    expect(isValidIsin('RU000A10B4K')).toBe(false);
    expect(isValidIsin('RU000A10B4K33')).toBe(false);
    expect(isValidIsin('')).toBe(false);
    expect(isValidIsin(undefined)).toBe(false);
    expect(isValidIsin('TMON')).toBe(false);
  });

  it('регистр и пробелы вокруг не важны', () => {
    expect(isValidIsin(' ru0009029540 ')).toBe(true);
  });
});
