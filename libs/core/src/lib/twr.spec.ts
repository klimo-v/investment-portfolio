import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { twrDayReturn, twrLevels } from './twr';

const d = (n: number | string) => new Decimal(n);

describe('twr', () => {
  it('нулевая база (капитала нет, потока нет) — день пропускается, а не NaN', () => {
    expect(twrDayReturn(d(0), d(0), d(0))).toBeNull();
    const { levels, capitalDays } = twrLevels([{ value: d(0), flow: d(0) }, { value: d(0), flow: d(0) }], d(0));
    expect(levels.map((l) => l.toNumber())).toEqual([100, 100]);
    expect(capitalDays).toBe(0);
  });

  it('ввод при нулевом остатке: база = ввод, прибыль первого дня считается', () => {
    const r = twrDayReturn(d(0), d(110), d(100)) as Decimal;
    expect(r.toNumber()).toBeCloseTo(0.1, 12);
  });

  it('вывод — в конце дня: база прежняя, результат дня не искажается', () => {
    // 220 → вывод 50 → 170: за день 0
    expect((twrDayReturn(d(220), d(170), d(-50)) as Decimal).toNumber()).toBe(0);
  });

  it('отрицательный капитал (журнал неполон) — день нулевой', () => {
    expect(twrDayReturn(d(-5), d(10), d(0))).toBeNull();
  });
});
