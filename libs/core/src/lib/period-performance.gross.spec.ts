import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { periodPerformance, suggestTwrStart } from './period-performance';
import type { ValuationSeries } from './valuation';

/**
 * Реальные цифры двух дней, на которых TWR раньше падал на −99,8%:
 *  - 04.09.2024: ввод 19 860,18 CNY (254 140,79 ₽), продажа с комиссией 1 016,83 ₽, вывод 253 121,66 ₽ в один день.
 *    Чистый поток дня +1 019,13 ₽ прятал, что ввод работал на базу 254 тыс.;
 *  - 07.03.2025: отдельная комиссия/налог 1 198 ₽ при остатке 2,18 ₽ в контуре позиций.
 */
const pt = (date: string, p: { invested: string; market: string; fixed: string; costs?: string; purchases?: string }) => ({
  date,
  investedRub: p.invested,
  marketValueRub: p.market,
  fixedRub: p.fixed,
  unrealizedRub: new Decimal(p.market).minus(p.invested).toFixed(2),
  totalRub: new Decimal(p.fixed).plus(new Decimal(p.market).minus(p.invested)).toFixed(2),
  standaloneCostsRub: p.costs,
  purchasesRub: p.purchases,
  carried: [],
});

function wealthSeries(withGross: boolean): ValuationSeries {
  return {
    from: null,
    till: '2024-09-05',
    groupBy: 'portfolio',
    groups: [
      {
        key: 'p',
        points: [
          pt('2024-09-03', { invested: '0.00', market: '0.00', fixed: '-935.80' }),
          pt('2024-09-04', { invested: '2.30', market: '2.28', fixed: '-1952.63' }),
          pt('2024-09-05', { invested: '2.30', market: '2.25', fixed: '-1952.63' }),
        ],
      },
    ],
    netContributionsRub: ['935.80', '1954.93', '1954.93'],
    ...(withGross
      ? { contributionInflowsRub: ['0.00', '254140.79', '0.00'], contributionOutflowsRub: ['0.00', '253121.66', '0.00'] }
      : {}),
  };
}

describe('TWR: ввод и вывод одного дня считаются раздельно (04.09.2024)', () => {
  it('валовый ввод в базе дня: −0,4%, а не −99,8%; просадка не катастрофическая', () => {
    const p = periodPerformance(wealthSeries(true), { contour: 'wealth' });
    const idx = Object.fromEntries(p.twr.series.map((x) => [x.date, x.index]));
    expect(idx['2024-09-04']).toBeCloseTo(99.6, 1);
    expect(p.maxDrawdownPct).toBeGreaterThan(-5); // дальше — курс юаня на остатке 0,18 CNY, а не комиссия
  });

  it('ряд без валовых потоков (старые данные) считается как раньше — по чистому потоку', () => {
    const p = periodPerformance(wealthSeries(false), { contour: 'wealth' });
    const idx = Object.fromEntries(p.twr.series.map((x) => [x.date, x.index]));
    expect(idx['2024-09-04']).toBeLessThan(1);
  });

  it('₽-результат и средний капитал не зависят от способа базы TWR', () => {
    const a = periodPerformance(wealthSeries(true), { contour: 'wealth' });
    const b = periodPerformance(wealthSeries(false), { contour: 'wealth' });
    expect(a.resultRub).toBe(b.resultRub);
    expect(a.netFlowRub).toBe(b.netFlowRub);
    expect(a.averageCapitalRub).toBe(b.averageCapitalRub);
  });
});

describe('TWR контура позиций: отдельная комиссия — расход счёта, а не приток капитала (07.03.2025)', () => {
  const series = (withCosts: boolean): ValuationSeries => ({
    from: null,
    till: '2025-03-08',
    groupBy: 'system',
    groups: [
      {
        key: 'core',
        points: [
          pt('2025-03-06', { invested: '2.30', market: '2.18', fixed: '-1952.63', costs: withCosts ? '0.00' : undefined, purchases: '0.00' }),
          pt('2025-03-07', { invested: '2.30', market: '2.18', fixed: '-3150.63', costs: withCosts ? '1198.00' : undefined, purchases: '0.00' }),
          pt('2025-03-08', { invested: '2.30', market: '2.19', fixed: '-3150.63', costs: withCosts ? '1198.00' : undefined, purchases: '0.00' }),
        ],
      },
    ],
    netContributionsRub: ['0.00', '0.00', '0.00'],
  });

  it('индекс в день комиссии не рушится; ₽-результат комиссию по-прежнему содержит', () => {
    const p = periodPerformance(series(true), { contour: 'positions', groupKey: 'core' });
    const idx = Object.fromEntries(p.twr.series.map((x) => [x.date, x.index]));
    expect(idx['2025-03-07']).toBeCloseTo(idx['2025-03-06'], 6);
    expect(Number(p.resultRub)).toBeLessThan(-1190);
  });

  it('без данных о расходах (старый ряд) поведение прежнее', () => {
    const p = periodPerformance(series(false), { contour: 'positions', groupKey: 'core' });
    const idx = Object.fromEntries(p.twr.series.map((x) => [x.date, x.index]));
    expect(idx['2025-03-07']).toBeLessThan(1);
  });
});

describe('suggestTwrStart — подсказка начала периода (на цифры не влияет)', () => {
  const day = (date: string, v: string) => ({ date, value: new Decimal(v) });

  it('ничтожный остаток до пополнения: подсказывает первый день значимого капитала', () => {
    const days = [day('2024-09-04', '2.28'), day('2025-02-25', '2.10'), day('2025-02-27', '493579.13'), day('2025-03-06', '504290.21')];
    expect(suggestTwrStart(days)).toBe('2025-02-27');
  });

  it('капитал значим с первого дня — подсказки нет', () => {
    expect(suggestTwrStart([day('2025-01-01', '100000'), day('2025-01-02', '101000')])).toBeNull();
  });

  it('капитал значим в конце не всегда: берётся начало ПОСЛЕДНЕГО значимого отрезка', () => {
    const days = [day('a', '100000'), day('b', '0.5'), day('c', '90000'), day('d', '95000')];
    expect(suggestTwrStart(days)).toBe('c');
  });

  it('в конце капитал ничтожен или его не было — null', () => {
    expect(suggestTwrStart([day('a', '100000'), day('b', '1')])).toBeNull();
    expect(suggestTwrStart([day('a', '0'), day('b', '0')])).toBeNull();
    expect(suggestTwrStart([])).toBeNull();
  });
});
