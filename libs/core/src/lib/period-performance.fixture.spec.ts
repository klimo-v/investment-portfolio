import { describe, expect, it } from 'vitest';
import { xirr, type CashFlow } from './metrics';
import Decimal from 'decimal.js';
import { twrLevels } from './twr';
import { PERIOD_FIXTURES, type PeriodFixture } from './period-performance.fixture';

/**
 * Эталоны этапа 0: ручные ответы фикстур сверяются с УЖЕ существующим кодом
 * (twrLevels, xirr), чтобы убедиться, что цифры в фикстурах верны, ещё до появления
 * periodPerformance. Потоки для XIRR собираются здесь по правилу из плана (§2.1):
 * отток V_start по рынку на дату базы, внешние потоки на их даты, приток V_end на конец.
 */

/** Индекс по богатству точек фикстуры: поток дня — изменение чистого ввода, первая точка — старт */
function timeWeightedIndex(points: readonly { totalRub: number; netContributionsRub: number }[]): number[] {
  const inputs = points.map((p, i) => ({
    value: new Decimal(p.netContributionsRub).plus(p.totalRub),
    flow: new Decimal(p.netContributionsRub).minus(i > 0 ? points[i - 1].netContributionsRub : 0),
  }));
  return twrLevels(inputs, null).levels.map((l) => l.toNumber());
}

const wealth = (p: PeriodFixture['points'][number]): number => p.netContributionsRub + p.totalRub;

function resultRub(f: PeriodFixture): number {
  const first = f.points[0];
  const last = f.points[f.points.length - 1];
  const flows = last.netContributionsRub - first.netContributionsRub;
  return wealth(last) - wealth(first) - flows;
}

function mwrFlows(f: PeriodFixture): CashFlow[] {
  const flows: CashFlow[] = [{ date: f.points[0].date, amount: -wealth(f.points[0]) }];
  for (let i = 1; i < f.points.length; i++) {
    const delta = f.points[i].netContributionsRub - f.points[i - 1].netContributionsRub;
    if (delta !== 0) flows.push({ date: f.points[i].date, amount: -delta });
  }
  flows.push({ date: f.points[f.points.length - 1].date, amount: wealth(f.points[f.points.length - 1]) });
  return flows;
}

describe('эталоны периода (этап 0)', () => {
  it.each(PERIOD_FIXTURES)('$name — результат ₽ = V_end − V_start − ΣF = Δ(зафиксированное + переоценка)', (f) => {
    const first = f.points[0];
    const last = f.points[f.points.length - 1];
    expect(resultRub(f)).toBeCloseTo(f.expected.resultRub, 2);
    // тот же результат через нарастающий итог ряда valuationSeries
    expect(last.totalRub - first.totalRub).toBeCloseTo(f.expected.resultRub, 2);
  });

  it.each(PERIOD_FIXTURES)('$name — TWR совпадает с ручным ответом', (f) => {
    const idx = timeWeightedIndex(f.points);
    expect(idx[idx.length - 1]).toBeCloseTo(f.expected.twrIndex, 6);
  });

  it.each(PERIOD_FIXTURES)('$name — XIRR совпадает с ручным ответом', (f) => {
    const rate = xirr(mwrFlows(f));
    expect(rate).not.toBeNull();
    expect(Math.abs((rate as number) * 100 - f.expected.mwrPct)).toBeLessThan(f.expected.mwrTolerancePp);
  });

  it('ввод в середине периода: TWR и MWR законно расходятся', () => {
    const f = PERIOD_FIXTURES.find((x) => x.name === 'midDepositBeforeFlat') as PeriodFixture;
    const twr = timeWeightedIndex(f.points).at(-1) as number;
    const mwr = (xirr(mwrFlows(f)) as number) * 100;
    expect(twr - 100).toBeGreaterThan(mwr + 2); // 10% против ≈6,7%
  });

  it('продажа в кэш: стоимость позиций падает в ноль, богатство и индекс — нет', () => {
    const f = PERIOD_FIXTURES.find((x) => x.name === 'saleToCash') as PeriodFixture;
    const [, before, after] = f.points;
    expect(after.marketValueRub).toBe(0);
    expect(wealth(after)).toBe(wealth(before));
    const idx = timeWeightedIndex(f.points);
    expect(idx[2]).toBeCloseTo(idx[1], 10);
  });

  it('открытые позиции на начало периода: база по рынку, а не по себестоимости', () => {
    const f = PERIOD_FIXTURES.find((x) => x.name === 'openAtStart') as PeriodFixture;
    const costBasis = f.points[0].netContributionsRub; // 100 000 — «себестоимость» старого расчёта
    const old = ((f.points[1].marketValueRub - costBasis) / costBasis) * 100; // 65%
    const marketBased = (resultRub(f) / wealth(f.points[0])) * 100; // 10%
    expect(old).toBeCloseTo(65, 6);
    expect(marketBased).toBeCloseTo(10, 6);
  });
});
