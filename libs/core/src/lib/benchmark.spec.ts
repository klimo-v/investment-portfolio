import { describe, expect, it } from 'vitest';
import { benchmarkInstrumentId, indexSeries, isBenchmarkSecid, rateIndexSeries } from './benchmark';

describe('indexSeries: индекс на базе 100', () => {
  const obs = [
    { date: '2026-01-02', value: 200 }, // пятница
    { date: '2026-01-05', value: 210 }, // понедельник
    { date: '2026-01-06', value: 189 },
  ];

  it('выходные заполняются последним закрытием, база — значение на первый день', () => {
    const s = indexSeries(obs, '2026-01-02', '2026-01-06');
    expect(s.map((p) => p.date)).toEqual(['2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06']);
    expect(s.map((p) => p.index)).toEqual([100, 100, 100, 105, 94.5]);
  });

  it('база берётся на дату `from` или раньше (последнее закрытие до периода)', () => {
    const s = indexSeries(obs, '2026-01-04', '2026-01-06');
    expect(s[0]).toEqual({ date: '2026-01-04', index: 100 }); // закрытие пятницы 200
    expect(s[s.length - 1].index).toBeCloseTo((189 / 200) * 100, 10);
  });

  it('история начинается позже from — ряд стартует с первой даты данных; пусто — пустой ряд', () => {
    expect(indexSeries(obs, '2025-12-01', '2026-01-02')[0]).toEqual({ date: '2026-01-02', index: 100 });
    expect(indexSeries([], '2026-01-01', '2026-01-05')).toEqual([]);
    expect(indexSeries(obs, '2026-02-01', '2026-02-05')[0].date).toBe('2026-02-01'); // закрытие 189 действует вперёд
  });
});

describe('rateIndexSeries: накопление по ставке денежного рынка', () => {
  it('365 дней под 10% годовых — ровно по ставке в день (простое накопление каждый день)', () => {
    const s = rateIndexSeries([{ date: '2025-01-01', value: 10 }], '2025-01-01', '2026-01-01');
    expect(s[0]).toEqual({ date: '2025-01-01', index: 100 });
    expect(s).toHaveLength(366);
    expect(s[s.length - 1].index).toBeCloseTo(100 * Math.pow(1 + 0.1 / 365, 365), 8);
  });

  it('ставка меняется по датам; в выходные действует последняя рабочая', () => {
    const s = rateIndexSeries(
      [
        { date: '2026-01-02', value: 365 }, // пятница: 1% в день
        { date: '2026-01-05', value: 0 }, // понедельник
      ],
      '2026-01-02',
      '2026-01-05',
    );
    expect(s.map((p) => Number(p.index.toFixed(4)))).toEqual([100, 101, 102.01, 0 + 102.01]);
  });

  it('до первой опубликованной ставки берётся первая известная; нет данных — пусто', () => {
    const s = rateIndexSeries([{ date: '2026-01-10', value: 365 }], '2026-01-01', '2026-01-03');
    expect(s[2].index).toBeCloseTo(102.01, 10);
    expect(rateIndexSeries([], '2026-01-01', '2026-01-03')).toEqual([]);
  });
});

describe('ориентиры', () => {
  it('допустимые SECID и id ряда в price_history', () => {
    expect(isBenchmarkSecid('MCFTRR')).toBe(true);
    expect(isBenchmarkSecid('RUSFAR')).toBe(true);
    expect(isBenchmarkSecid('SBER')).toBe(false);
    expect(benchmarkInstrumentId('mcftrr')).toBe('index:MCFTRR');
  });
});
