import { TestBed } from '@angular/core/testing';
import type { Chart, ChartConfiguration, LegendElement, TooltipItem, TooltipModel } from 'chart.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValuationSeriesSchema } from '@core';
import { PositionsSeriesChart } from './positions-series-chart';

const series = ValuationSeriesSchema.parse({
  from: '2026-09-01',
  till: '2026-09-03',
  groupBy: 'instrument',
  hasCash: true,
  groups: [
    {
      key: 'A',
      name: 'Закрытая бумага',
      points: [100, 120, 0].map((value, i) => ({
        date: `2026-09-0${i + 1}`,
        marketValueRub: String(value),
        investedRub: String(value),
        fixedRub: '0',
        unrealizedRub: '0',
        totalRub: '0',
        carried: i === 1 ? [{ instrumentId: 'A', reason: 'no-price', priceDate: null }] : [],
      })),
    },
    {
      key: 'B',
      name: 'Другая бумага',
      points: [0, 200, 210].map((value, i) => ({
        date: `2026-09-0${i + 1}`,
        marketValueRub: String(value),
        investedRub: String(value),
        fixedRub: '0',
        unrealizedRub: '0',
        totalRub: '0',
        carried: [],
      })),
    },
  ],
  cashRub: ['-50', '10', '130'],
  netContributionsRub: ['50', '330', '330'],
  events: [
    {
      date: '2026-09-02',
      kind: 'payout',
      instrumentId: 'A',
      name: 'Закрытая бумага',
      amountRub: '10',
    },
    { date: '2026-09-02', kind: 'sale', instrumentId: 'B', name: 'Другая бумага', amountRub: '20' },
  ],
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('Отсутствует обязательная настройка графика');
  return value;
}

function setup() {
  const fixture = TestBed.createComponent(PositionsSeriesChart);
  fixture.componentRef.setInput('series', series);
  // Конфигурацию проверяем без canvas: браузерный рендер проверяется отдельно.
  const config = required(fixture.componentInstance['config']());
  const visible = config.data.datasets.map(() => true);
  const chart = {
    data: config.data,
    isDatasetVisible: (i: number) => visible[i],
    setDatasetVisibility: (i: number, value: boolean) => {
      visible[i] = value;
    },
    update: vi.fn(() =>
      required(required(config.plugins)[0].afterUpdate)(chart, { mode: 'none' }, {}),
    ),
    setActiveElements: vi.fn(),
    scales: { x: { getValueForPixel: (x: number) => x, getPixelForValue: (i: number) => i } },
    chartArea: { top: 0 },
    tooltip: { setActiveElements: vi.fn() },
  } as unknown as Chart<'line'>;
  required(required(config.plugins)[0].afterUpdate)(chart, { mode: 'none' }, {});
  const legend = { chart } as LegendElement<'line'>;
  const click = (index: number, detail = 0) => {
    const onClick = required(required(required(required(config.options).plugins).legend).onClick);
    onClick.call(
      legend,
      { type: 'click', x: 0, y: 0, native: new MouseEvent('click', { detail }) },
      { text: '', datasetIndex: index },
      legend,
    );
  };
  const hover = (day: number) => {
    const event = { type: 'mousemove' as const, x: day, y: 1, native: null };
    required(required(config.plugins)[0].beforeEvent)(
      chart,
      { event, inChartArea: true, replay: false, cancelable: true },
      {},
    );
    required(required(config.plugins)[0].afterEvent)(
      chart,
      { event, inChartArea: true, replay: false, cancelable: false },
      {},
    );
  };
  return { config, visible, chart, click, hover, component: fixture.componentInstance };
}

function item(
  config: ChartConfiguration<'line'>,
  datasetIndex: number,
  dataIndex: number,
): TooltipItem<'line'> {
  return {
    datasetIndex,
    dataIndex,
    dataset: config.data.datasets[datasetIndex],
    parsed: { x: dataIndex, y: config.data.datasets[datasetIndex].data[dataIndex] },
  } as TooltipItem<'line'>;
}

beforeEach(() => TestBed.overrideComponent(PositionsSeriesChart, { set: { template: '' } }));
afterEach(() => vi.useRealTimers());

describe('Стоимость инструментов во времени', () => {
  it('рисует собственную стоимость, разрывы и отрицательный остаток', () => {
    const { config } = setup();
    expect(config.data.datasets[0].data).toEqual([100, 120, null]);
    expect(config.data.datasets[1].data).toEqual([null, 200, 210]);
    expect(config.data.datasets[2].data).toEqual([-50, 10, 130]);
    expect(config.data.datasets[3].data).toEqual([50, 330, 340]);
    expect(required(required(required(config.options).scales)['y']).stacked).toBe(false);
    expect(config.data.datasets.every((d) => !d.fill && !d.stack)).toBe(true);
  });

  it('двойной клик равен ручному скрытию всех остальных пунктов без промежуточного переключения', () => {
    vi.useFakeTimers();
    const manual = setup();
    for (let i = 1; i < manual.visible.length; i++) {
      manual.click(i);
      vi.advanceTimersByTime(451);
    }
    const double = setup();
    double.click(0);
    expect(double.visible.every(Boolean)).toBe(true);
    double.click(0);
    expect(double.visible).toEqual(manual.visible);
    expect(double.chart.update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(double.chart.update).toHaveBeenCalledTimes(1);
    expect(double.config.data.datasets).toHaveLength(7);
    double.click(1);
    double.click(1);
    expect(double.visible).toEqual([false, true, false, false, false, false, false]);
    double.click(1);
    double.click(1);
    expect(double.visible.every(Boolean)).toBe(true);
  });

  it('распознаёт объединённые браузером клики по detail второго события', () => {
    const state = setup();
    state.click(0, 2);
    expect(state.visible).toEqual([true, false, false, false, false, false, false]);
    expect(state.chart.update).toHaveBeenCalledTimes(1);
  });

  it('показывает сброс при скрытии любого ряда и возвращает всё, отменяя ожидающий клик', () => {
    vi.useFakeTimers();
    const state = setup();
    expect(state.component['hasHiddenSeries']()).toBe(false);
    // Даже скрытие одного маркера должно включать кнопку.
    state.click(6);
    vi.advanceTimersByTime(451);
    expect(state.component['hasHiddenSeries']()).toBe(true);
    state.click(1);
    state.component['showAll']();
    vi.advanceTimersByTime(1000);
    expect(state.visible.every(Boolean)).toBe(true);
    expect(state.component['hasHiddenSeries']()).toBe(false);
    state.click(0);
    state.click(0);
    expect(state.component['hasHiddenSeries']()).toBe(true);
    state.component['showAll']();
    expect(state.visible.every(Boolean)).toBe(true);
    expect(state.component['hasHiddenSeries']()).toBe(false);
  });

  it('повторный двойной клик восстанавливает исходный вид и после ручного выбора одной бумаги', () => {
    vi.useFakeTimers();
    const state = setup();
    for (let i = 1; i < state.visible.length; i++) {
      state.click(i);
      vi.advanceTimersByTime(451);
    }
    state.click(0);
    state.click(0);
    expect(state.visible.every(Boolean)).toBe(true);
  });

  it('подсказка учитывает стоимость на историческую дату и сортирует только бумаги', () => {
    const { config } = setup();
    const tooltip = required(required(required(config.options).plugins).tooltip);
    const filter = required(tooltip.filter);
    expect(filter(item(config, 0, 1), 0, [], config.data)).toBe(true);
    expect(filter(item(config, 0, 2), 0, [], config.data)).toBe(false);
    expect(filter(item(config, 2, 0), 0, [], config.data)).toBe(true);
    expect(filter(item(config, 5, 1), 0, [], config.data)).toBe(false);
    expect(
      required(tooltip.itemSort)(item(config, 0, 1), item(config, 1, 1), config.data),
    ).toBeGreaterThan(0);
    expect(
      required(tooltip.itemSort)(item(config, 1, 1), item(config, 3, 1), config.data),
    ).toBeLessThan(0);
  });

  it('выбирает точный день в разрыве и скрывает события и замечания по той же видимости', () => {
    vi.useFakeTimers();
    const { config, chart, hover, click } = setup();
    hover(1);
    const context = { chart } as unknown as TooltipModel<'line'>;
    const callbacks = required(
      required(required(required(config.options).plugins).tooltip).callbacks,
    );
    expect(required(callbacks.afterBody).call(context, [])).toHaveLength(3);
    click(1);
    click(1);
    hover(1);
    expect(required(callbacks.afterBody).call(context, [])).toEqual([]);
    hover(2);
    expect(required(callbacks.title).call(context, [])).toBe('2026-09-03');
    expect(required(chart.tooltip).setActiveElements).toHaveBeenLastCalledWith(
      [{ datasetIndex: 1, index: 2 }],
      { x: 2, y: 12 },
    );
    hover(0);
    expect(required(callbacks.title).call(context, [])).toBe('2026-09-01');
  });
});
