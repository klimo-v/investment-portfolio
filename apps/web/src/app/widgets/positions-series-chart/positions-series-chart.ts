import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import type { Chart, ChartConfiguration, Plugin } from 'chart.js';
import type { ValuationSeriesDto } from '@core';
import { chartSemantic, formatRub, seriesColor, ThemeService } from '@web-shared';
import { ChartCanvas } from '../chart-canvas/chart-canvas';

/** Дневная стоимость каждого инструмента, фактический кэш, итог и чистый ввод.
 * Разрывы линий обозначают отсутствие позиции. Выплаты и продажи — отдельные маркеры.
 * Все элементы используют видимость рядов Chart.js, в том числе при выборе одной бумаги.
 */
@Component({
  selector: 'app-positions-series-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatButtonModule, ChartCanvas],
  template: `
    <mat-card>
      <div class="chart-header">
        <h3>Стоимость инструментов во времени</h3>
        @if (hasHiddenSeries()) {
          <button mat-button type="button" (click)="showAll()">Показать все</button>
        }
      </div>
      <p class="note">
        Каждая линия — стоимость инструмента в рублях; разрывы — периоды без позиции. «Деньги» —
        свободный остаток счёта, «Итого» — стоимость позиций плюс деньги. Пунктир — внесено (нетто):
        депозиты минус выводы. ▲ — выплата, ◆ — продажа (сумма в подсказке). Янтарные точки отмечают
        дни, где цена инструмента не найдена или взята от более ранней даты.
      </p>
      @if (series(); as s) {
        @if (!s.hasCash && s.groups.length > 0) {
          <p class="note">
            Линии «Деньги» нет: у системы/инструмента нет своего кэша — деньги от продаж и выплат
            уходят в общий кэш портфеля, поэтому линия «Итого» здесь падает при каждой продаже.
            Выплаты и продажи отмечены маркерами.
          </p>
        }
      }
      @if (negativeCash()) {
        <p class="note warn">
          Кэш по журналу отрицательный: в журнале не хватает ввода денег (пополнений или переводов),
          остаток «Денег» уходит ниже нуля.
        </p>
      }
      @if (config(); as cfg) {
        <app-chart-canvas [config]="cfg" [tall]="true" />
      } @else {
        <p class="note">Операций пока нет — график появится после первой сделки.</p>
      }
    </mat-card>
  `,
  styles: [
    `
      mat-card {
        padding: 16px;
      }
      .chart-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-height: 40px;
        margin-bottom: 8px;
      }
      .chart-header button {
        flex-shrink: 0;
        white-space: nowrap;
      }
      h3 {
        margin: 0;
        font-weight: 500;
      }
      .note {
        margin: 0 0 12px;
        font-size: 13px;
        color: var(--app-text-muted);
      }
      .warn {
        color: var(--app-negative, #c0392b);
      }
    `,
  ],
})
export class PositionsSeriesChart {
  /** Дневной ряд по инструментам; undefined — ещё не загружен */
  readonly series = input<ValuationSeriesDto | undefined>(undefined);

  protected readonly hasHiddenSeries = signal(false);
  private activeChart?: Chart;
  private cancelLegendClick?: () => void;

  protected showAll(): void {
    const chart = this.activeChart;
    if (!chart) return;
    // Отложенный одиночный клик не должен снова скрыть ряд после сброса.
    this.cancelLegendClick?.();
    chart.data.datasets.forEach((_, index) => chart.setDatasetVisibility(index, true));
    chart.update();
  }

  private readonly theme = inject(ThemeService);
  private readonly cc = computed(() => chartSemantic(this.theme.isDark()));

  /** Вычисленный кэш ушёл ниже нуля — сигнал неполноты журнала (подробный список — этап «Полнота журнала») */
  protected readonly negativeCash = computed(() =>
    (this.series()?.cashRub ?? []).some((c) => Number(c) < -0.005),
  );

  protected readonly config = computed<ChartConfiguration<'line'> | null>(() => {
    const s = this.series();
    const groups = s?.groups ?? [];
    if (!s || groups.length === 0 || groups[0].points.length === 0) return null;
    const dates = groups[0].points.map((p) => p.date);

    const instrumentDatasets = groups.map((g, i) => ({
      label: g.name,
      data: g.points.map((p) => (Number(p.marketValueRub) === 0 ? null : Number(p.marketValueRub))),
      borderColor: seriesColor(i),
      backgroundColor: seriesColor(i),
      borderWidth: 1.5,
      pointRadius: 0,
      spanGaps: false,
      tension: 0.2,
      fill: false,
    }));

    const positions = dates.map((_, i) =>
      groups.reduce((sum, g) => sum + Number(g.points[i].marketValueRub), 0),
    );
    const cash = s.hasCash ? s.cashRub.map(Number) : [];
    // Стоимость всего портфеля не зависит от скрытия отдельных линий.
    const total = positions.map((v, i) => v + (cash[i] ?? 0));

    const totalIndex = groups.length + (s.hasCash ? 1 : 0);
    const payoutIndex = totalIndex + 1 + (s.hasCash ? 1 : 0);
    const saleIndex = payoutIndex + 1;
    const dayIndex = new Map(dates.map((d, i) => [d, i]));
    const markers = (kind: 'payout' | 'sale'): (number | null)[] => {
      const data: (number | null)[] = dates.map(() => null);
      for (const e of s.events) {
        const i = dayIndex.get(e.date);
        if (i !== undefined && e.kind === kind) data[i] = total[i];
      }
      return data;
    };
    const payoutMarkers = markers('payout');
    const saleMarkers = markers('sale');
    // что именно подменено на день: по инструментам из групп (уникальные пары, без дублей)
    const carriedAt = (chart: Chart, i: number): string[] => {
      const seen = new Set<string>();
      for (const [index, g] of groups.entries()) {
        if (!chart.isDatasetVisible(totalIndex) && !chart.isDatasetVisible(index)) continue;
        if (Number(g.points[i].marketValueRub) === 0) continue;
        for (const c of g.points[i].carried) {
          const text =
            c.reason === 'no-price'
              ? `${g.name}: цена на дату не найдена, оценено по себестоимости`
              : c.reason === 'no-fx'
                ? `${g.name}: нет курса валюты цены, оценено по себестоимости`
                : `${g.name}: цена на дату не найдена, взята от ${c.priceDate}`;
          seen.add(text);
        }
      }
      return [...seen];
    };
    const flagged = dates.map((_, i) => groups.some((g) => g.points[i].carried.length > 0));

    // Первый клик ждёт второй: двойной клик не успевает переключить отдельный ряд.
    let pending: { index: number; timer: ReturnType<typeof setTimeout> } | undefined;
    const clearPending = () => {
      if (pending) clearTimeout(pending.timer);
      pending = undefined;
    };
    let selectedDay: number | undefined;
    const selectionPlugin: Plugin<'line'> = {
      id: 'positions-selection',
      afterUpdate: (chart) => {
        this.activeChart = chart;
        this.cancelLegendClick = clearPending;
        this.hasHiddenSeries.set(
          chart.data.datasets.some((_, index) => !chart.isDatasetVisible(index)),
        );
      },
      beforeDestroy: (chart) => {
        clearPending();
        if (this.activeChart === chart) {
          this.activeChart = undefined;
          this.cancelLegendClick = undefined;
          this.hasHiddenSeries.set(false);
        }
      },
      beforeEvent: (chart, args) => {
        const { event, inChartArea } = args;
        selectedDay =
          inChartArea && event.type !== 'mouseout' && event.x !== null
            ? Math.max(
                0,
                Math.min(
                  dates.length - 1,
                  Math.round(chart.scales['x'].getValueForPixel(event.x) ?? 0),
                ),
              )
            : undefined;
      },
      afterEvent: (chart, args) => {
        const day = selectedDay;
        // Выбираем день по оси X даже в разрыве линии, без привязки к ближайшей
        // ненулевой позиции. Нулевые инструменты затем исключает filter подсказки.
        const active =
          day === undefined
            ? []
            : chart.data.datasets.flatMap((_, datasetIndex) =>
                chart.isDatasetVisible(datasetIndex) ? [{ datasetIndex, index: day }] : [],
              );
        chart.setActiveElements(active);
        chart.tooltip?.setActiveElements(active, {
          x: selectedDay === undefined ? 0 : chart.scales['x'].getPixelForValue(selectedDay),
          y: chart.chartArea.top + 12,
        });
        args.changed = true;
      },
      beforeDatasetsDraw: (chart) => {
        const active = chart.tooltip?.getActiveElements()[0];
        if (!active || !chart.tooltip?.opacity) return;
        const x = chart.scales['x'].getPixelForValue(active.index);
        const { ctx, chartArea } = chart;
        ctx.save();
        ctx.strokeStyle = this.cc().neutral;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.restore();
      },
    };

    return {
      type: 'line',
      plugins: [selectionPlugin],
      data: {
        labels: dates,
        datasets: [
          ...instrumentDatasets,
          ...(s.hasCash
            ? [
                {
                  label: 'Деньги',
                  data: cash,
                  borderColor: this.cc().neutral,
                  backgroundColor: this.cc().neutral,
                  borderWidth: 1,
                  pointRadius: 0,
                  tension: 0,
                  fill: false,
                },
              ]
            : []),
          {
            label: s.hasCash ? 'Итого (позиции + деньги)' : 'Итого (позиции)',
            data: total,
            borderColor: this.cc().total,
            backgroundColor: this.cc().total,
            borderWidth: 2.5,

            pointRadius: (c) => (flagged[c.dataIndex] ? 3 : 0),
            pointBackgroundColor: (c) =>
              flagged[c.dataIndex] ? this.cc().benchmark : this.cc().total,
            pointBorderColor: (c) => (flagged[c.dataIndex] ? this.cc().benchmark : this.cc().total),
            tension: 0.2,
          },
          ...(s.hasCash
            ? [
                {
                  label: 'Внесено (нетто)',
                  data: s.netContributionsRub.map(Number),
                  borderColor: this.cc().neutral,
                  backgroundColor: this.cc().neutral,
                  borderWidth: 2,
                  borderDash: [6, 4],
                  pointRadius: 0,
                  tension: 0,
                },
              ]
            : []),
          {
            label: '▲ Выплата',
            data: payoutMarkers,
            showLine: false,
            borderColor: this.cc().total,
            backgroundColor: this.cc().benchmark,
            pointStyle: 'triangle' as const,
            pointRadius: 6,
            pointHoverRadius: 8,
          },
          {
            label: '◆ Продажа',
            data: saleMarkers,
            showLine: false,
            borderColor: this.cc().total,
            backgroundColor: this.cc().deposit,
            pointStyle: 'rectRot' as const,
            pointRadius: 5,
            pointHoverRadius: 7,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        layout: { padding: { right: 12 } },
        interaction: { axis: 'x', mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            onClick: (_event, item, legend) => {
              const index = item.datasetIndex;
              if (index === undefined) return;
              const chart = legend.chart;
              if (
                index < groups.length &&
                (pending?.index === index ||
                  (_event.native instanceof MouseEvent && _event.native.detail === 2))
              ) {
                clearPending();
                const onlyThis = chart.data.datasets.every(
                  (_, i) => chart.isDatasetVisible(i) === (i === index),
                );
                chart.data.datasets.forEach((_, i) =>
                  chart.setDatasetVisibility(i, onlyThis || i === index),
                );
                chart.update();
                return;
              }
              // Быстрые клики по разным пунктам — отдельные одиночные действия.
              if (pending) {
                chart.setDatasetVisibility(pending.index, !chart.isDatasetVisible(pending.index));
                clearPending();
                chart.update();
              }
              pending = {
                index,
                timer: setTimeout(() => {
                  pending = undefined;
                  chart.setDatasetVisibility(index, !chart.isDatasetVisible(index));
                  chart.update();
                }, 450),
              };
            },
          },
          tooltip: {
            position: 'nearest',
            caretSize: 6,
            filter: (item) =>
              item.datasetIndex < payoutIndex &&
              item.parsed.y !== null &&
              (item.datasetIndex >= groups.length || item.parsed.y !== 0),
            itemSort: (a, b) => {
              const aInstrument = a.datasetIndex < groups.length;
              const bInstrument = b.datasetIndex < groups.length;
              if (aInstrument && bInstrument) return (b.parsed.y ?? 0) - (a.parsed.y ?? 0);
              return aInstrument === bInstrument
                ? a.datasetIndex - b.datasetIndex
                : aInstrument
                  ? -1
                  : 1;
            },
            callbacks: {
              title: () => (selectedDay === undefined ? '' : dates[selectedDay]),
              label: (c) => `${c.dataset.label}: ${formatRub(c.parsed.y)}`,
              afterBody: function () {
                if (selectedDay === undefined) return [];
                const dataIndex = selectedDay;
                const chart = this.chart;
                const events = s.events.filter(
                  (e) =>
                    e.date === dates[dataIndex] &&
                    chart.isDatasetVisible(e.kind === 'payout' ? payoutIndex : saleIndex),
                );
                return [
                  ...events.map(
                    (e) =>
                      `${e.kind === 'payout' ? '▲ выплата' : '◆ продажа'} ${e.name}: ${formatRub(Number(e.amountRub))}`,
                  ),
                  ...carriedAt(chart, dataIndex),
                ];
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false } },
          y: {
            stacked: false,
            ticks: { callback: (v) => '₽' + Math.round(Number(v) / 1000) + 'k' },
          },
        },
      },
    };
  });
}
