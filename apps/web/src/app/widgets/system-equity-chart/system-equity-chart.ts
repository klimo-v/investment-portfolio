import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import type { ChartConfiguration } from 'chart.js';
import type { SystemPerformance } from '@core';
import { chartSemantic, formatRub, StateMessage, ThemeService } from '@web-shared';
import { ChartCanvas } from '../chart-canvas/chart-canvas';

/** `trades` — по закрытым сделкам; `result` — результат системы (зафиксированное + «сегодня») */
export type EquityCurve = 'trades' | 'result';

/**
 * Кривая эквити системы (накопленный реализованный результат по дате закрытия сделок)
 * и просадка от пика заливкой. Нереализованный результат по открытой позиции сюда не
 * подмешивается — он показан отдельной плашкой.
 */
@Component({
  selector: 'app-system-equity-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatButtonToggleModule, StateMessage, ChartCanvas],
  template: `
    <mat-card>
      <div class="head">
        <h3>{{ curve() === 'result' ? 'Результат системы' : 'Эквити и просадка' }}</h3>
        <mat-button-toggle-group
          [value]="curve()"
          (change)="curveChange.emit($event.value)"
          hideSingleSelectionIndicator
          aria-label="Какая кривая показана"
        >
          <mat-button-toggle value="result">Результат системы</mat-button-toggle>
          <mat-button-toggle value="trades">Закрытые сделки</mat-button-toggle>
        </mat-button-toggle-group>
      </div>
      <p class="note">{{ note() }}</p>
      @if (config(); as cfg) {
        <app-chart-canvas [config]="cfg" />
      } @else {
        <app-state-message kind="empty" icon="show_chart" title="Нет данных" [hint]="emptyHint()" />
      }
    </mat-card>
  `,
  styles: [
    `
      mat-card {
        padding: 16px;
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      h3 {
        margin: 0 0 8px;
        font-weight: 500;
      }
      .note {
        margin: 0 0 8px;
        font-size: 13px;
        color: var(--app-text-muted);
      }
    `,
  ],
})
export class SystemEquityChart {
  readonly performance = input.required<SystemPerformance>();
  readonly curve = input<EquityCurve>('result');
  readonly curveChange = output<EquityCurve>();

  protected readonly note = computed(() =>
    this.curve() === 'result'
      ? 'Зафиксированное (все продажи, в т.ч. частичные; дивиденды и купоны; за вычетом комиссий) нарастающим итогом. Пунктир — сегодня: плюс переоценка остатка по текущим котировкам.'
      : 'Накопленный результат по дате закрытия каждой сделки. Показывает качество входов и выходов, без дивидендов и открытых позиций.',
  );
  protected readonly emptyHint = computed(() =>
    this.curve() === 'result' ? 'Кривая появится после первой операции.' : 'Кривая появится после первой закрытой сделки.',
  );

  private readonly theme = inject(ThemeService);
  private readonly cc = computed(() => chartSemantic(this.theme.isDark()));

  protected readonly config = computed<ChartConfiguration<'line'> | null>(() =>
    this.curve() === 'result' ? this.resultConfig() : this.tradesConfig(),
  );

  /** Результат системы: сплошная линия — зафиксированное, пунктирный хвост — «сегодня» */
  private readonly resultConfig = computed<ChartConfiguration<'line'> | null>(() => {
    const { result, today } = this.performance().series;
    const points = [
      ...result.map((p) => ({ date: p.date, value: Number(p.fixedRub) })),
      ...(today && result.length > 0 ? [{ date: today.date, value: Number(today.totalRub) }] : []),
    ];
    if (points.length < 2) return null;
    const cc = this.cc();
    const lastIdx = points.length - 1;
    return {
      type: 'line',
      data: {
        labels: points.map((p) => p.date),
        datasets: [
          {
            label: 'Результат, ₽',
            data: points.map((p) => p.value),
            borderColor: cc.total,
            backgroundColor: cc.total,
            pointRadius: (c) => (c.dataIndex === lastIdx && today ? 4 : 2),
            tension: 0,
            // последний отрезок до «сегодня» — пунктиром: там есть бумажная переоценка
            segment: {
              borderDash: (c) => (today && c.p1DataIndex === lastIdx ? [6, 4] : undefined),
            },
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          tooltip: {
            callbacks: {
              label: (c) => `${c.dataset.label}: ${formatRub(c.parsed.y)}`,
              afterLabel: (c) =>
                today && c.dataIndex === lastIdx
                  ? `зафиксировано ${formatRub(Number(today.fixedRub))}, переоценка ${formatRub(Number(today.unrealizedRub))}`
                  : '',
            },
          },
        },
        scales: { y: { ticks: { callback: (v) => formatRub(Number(v)) } } },
      },
    };
  });

  private readonly tradesConfig = computed<ChartConfiguration<'line'> | null>(() => {
    const points = this.performance().series.equity;
    if (points.length < 2) return null;
    const cc = this.cc();
    return {
      type: 'line',
      data: {
        labels: points.map((p) => p.date),
        datasets: [
          {
            label: 'Эквити, ₽',
            data: points.map((p) => Number(p.equityRub)),
            borderColor: cc.total,
            backgroundColor: cc.total,
            pointRadius: 3,
            tension: 0,
          },
          {
            label: 'Просадка, ₽',
            data: points.map((p) => Number(p.drawdownRub)),
            borderColor: cc.negative,
            backgroundColor: cc.negative + '55',
            fill: 'origin',
            pointRadius: 0,
            tension: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${formatRub(c.parsed.y)}` } },
        },
        scales: { y: { ticks: { callback: (v) => formatRub(Number(v)) } } },
      },
    };
  });
}
