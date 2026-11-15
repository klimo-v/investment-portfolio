import { describe, expect, it } from 'vitest';
import { PriceCursor, fxRateAt } from './valuation';
import { plainQuoteDecimal, quoteValuesIssue } from './quote-values';
describe('Десятичные котировки', () => {
  it.each([
    ['1e-12', '0.000000000001'],
    ['1.23456789123456789123456789e-12', '0.00000000000123456789123456789123456789'],
    ['1.23456789123456789123456789e25', '12345678912345678912345678.9'],
    ['-4e-12', '-0.000000000004'],
    ['0', '0'],
  ])('обычная запись %s без округления', (raw, expected) => {
    expect(plainQuoteDecimal(raw)).toBe(expected);
  });
  it.each(['0', '0.0000123456789123456789', '2.134567', '1e-12'])(
    'точная строка %s допустима с null и нулевым НКД',
    (price) => {
      expect(quoteValuesIssue(price, null)).toBeNull();
      expect(quoteValuesIssue(price, '0')).toBeNull();
    },
  );
  it('отрицательная расчётная цена фьючерса допустима', () => {
    expect(quoteValuesIssue('-12.3456789', null, true)).toBeNull();
  });
  it.each(['', ' ', 'broken-price', 'NaN', 'Infinity', '-Infinity'])('не принимает %s', (price) =>
    expect(quoteValuesIssue(price, null)).toBe('Некорректная цена'),
  );
  it('испорченный исторический курс возвращает null на выбранную дату', () => {
    const cursor = new PriceCursor([
      {
        instrumentId: 'fx:USD',
        date: '2026-01-01',
        price: 'broken',
        currency: 'RUB',
        source: 'cbr',
      },
    ]);
    expect(fxRateAt('USD', '2026-01-02', cursor)).toBeNull();
  });
});
