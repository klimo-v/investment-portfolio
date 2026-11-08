import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { twrDayReturn, twrLevels } from './twr';

/** Индекс по богатству W = чистый ввод + итог; поток дня — изменение чистого ввода (первая точка — старт) */
function wealthIndex(points: readonly { totalRub: number; netContributionsRub: number }[]): number[] {
  const inputs = points.map((p, i) => ({
    value: new Decimal(p.netContributionsRub).plus(p.totalRub),
    flow: new Decimal(p.netContributionsRub).minus(i > 0 ? points[i - 1].netContributionsRub : 0),
  }));
  return twrLevels(inputs, null).levels.map((l) => l.toNumber());
}

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

  it('расход на пустом месте (капитала нет ни в начале, ни в конце дня) — день пропускается, индекс не обнуляется', () => {
    // отдельная комиссия 1 198 ₽ до первой покупки: поток +1 198, стоимость 0 → раньше r = −100% навсегда
    expect(twrDayReturn(d(0), d(0), d(1198))).toBeNull();
    const { levels } = twrLevels(
      [
        { value: d(0), flow: d(1198) }, // комиссия на пустой системе
        { value: d(1_000_000), flow: d(1_000_000) }, // первая покупка
        { value: d(1_100_000), flow: d(0) }, // +10%
      ],
      d(0),
    );
    expect(levels.map((l) => l.toNumber())).toEqual([100, 100, 110]);
  });

  it('отрицательный капитал (журнал неполон) — день нулевой', () => {
    expect(twrDayReturn(d(-5), d(10), d(0))).toBeNull();
  });
});

describe('twrLevels на богатстве (чистый ввод + итог): доходность без потоков', () => {
  it('довнесение и продажа индекс не двигают, рост цены — двигает', () => {
    const idx = wealthIndex([
      { totalRub: 0, netContributionsRub: 1000 }, // внесли 1000, ещё не покупали
      { totalRub: 100, netContributionsRub: 1000 }, // +10%
      { totalRub: 100, netContributionsRub: 2000 }, // довнесли 1000 — индекс не растёт
      { totalRub: 100, netContributionsRub: 2000 }, // продали позицию (кэш) — итог тот же, индекс не падает
      { totalRub: 320, netContributionsRub: 2000 }, // +220 на 2100 ≈ +10,476%
    ]);
    expect(idx[0]).toBe(100);
    expect(idx[1]).toBeCloseTo(110, 10);
    expect(idx[2]).toBeCloseTo(110, 10);
    expect(idx[3]).toBeCloseTo(110, 10);
    expect(idx[4]).toBeCloseTo(110 * (1 + 220 / 2100), 10);
  });

  it('вывод денег не падение; убыток — падение; до первого богатства база 100', () => {
    const idx = wealthIndex([
      { totalRub: 0, netContributionsRub: 0 },
      { totalRub: 0, netContributionsRub: 1000 },
      { totalRub: -100, netContributionsRub: 1000 }, // −10%
      { totalRub: -100, netContributionsRub: 500 }, // вывели 500: богатство 400 → 400−900−(−500)=0, доходность 0
    ]);
    expect(idx[0]).toBe(100);
    expect(idx[1]).toBe(100);
    expect(idx[2]).toBeCloseTo(90, 10);
    expect(idx[3]).toBeCloseTo(90, 10);
  });

  it('крупный ввод после почти нулевого остатка не даёт ложной просадки (ввод — в начале дня)', () => {
    const idx = wealthIndex([
      { totalRub: 9214, netContributionsRub: -8016 }, // остаток 1 198 ₽ после вывода
      { totalRub: 8238.49, netContributionsRub: 1991983.91 }, // внесли 2 млн ₽, за день −976 ₽ (комиссии)
    ]);
    // −976 ₽ на капитал ≈ 2 001 198 ₽, а не на вчерашние 1 198 ₽
    expect(idx[1]).toBeCloseTo(99.95, 2);
    expect(idx[1]).toBeGreaterThan(99.9);
  });

  it('нулевое/отрицательное богатство не даёт деления на ноль', () => {
    const idx = wealthIndex([
      { totalRub: -50, netContributionsRub: 0 },
      { totalRub: -20, netContributionsRub: 0 },
    ]);
    expect(idx.every(Number.isFinite)).toBe(true);
  });
});
