import { describe, expect, it } from 'vitest';
import { formatHolding } from './system-kpis';

describe('formatHolding', () => {
  it('нет данных — прочерк', () => {
    expect(formatHolding(null, true)).toBe('—');
  });
  it('есть время и меньше двух суток — часы', () => {
    expect(formatHolding(20.5, true)).toBe('20.5 ч');
    expect(formatHolding(3, true)).toBe('3 ч');
  });
  it('двое суток и больше — дни, даже при наличии времени', () => {
    expect(formatHolding(72, true)).toBe('3 дн.');
  });
  it('без времени срок известен только в днях', () => {
    expect(formatHolding(24, false)).toBe('1 дн.');
    expect(formatHolding(36, false)).toBe('1.5 дн.');
  });
});
