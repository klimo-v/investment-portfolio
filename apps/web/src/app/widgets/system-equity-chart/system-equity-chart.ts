import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { ChartConfiguration } from 'chart.js';
import type { SystemPerformance } from '@core';
import { chartSemantic, formatRub, StateMessage, ThemeService } from '@web-shared';
import { ChartCanvas } from '../chart-canvas/chart-canvas';

/**
 * Кривая эквити системы (накопленный реализованный результат по дате закрытия сделок)
 * и просадка от пика заливкой. Нереализованный результат по открытой позиции сюда не
 * подмешивается — он показан отдельной плашкой.
 */
@Component({
  selector: 'app-system-equity-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, StateMessage, ChartCanvas],
  template: `
    <mat-card>
      <h3>Эквити и просадка</h3>
      @if (config(); as cfg) {
        <app-chart-canvas [config]="cfg" />
      } @else {
        <app-state-message kind="empty" icon="show_chart" title="Нет закрытых сделок" hint="Кривая появится после первой закрытой сделки." />
      }
    </mat-card>
  `,
  styles: [
    `
      mat-card {
        padding: 16px;
      }
      h3 {
        margin: 0 0 8px;
        font-weight: 500;
      }
    `,
  ],
})
export class SystemEquityChart {
  readonly performance = input.required<SystemPerformance>();

  private readonly theme = inject(ThemeService);
  private readonly cc = computed(() => chartSemantic(this.theme.isDark()));

  protected readonly config = computed<ChartConfiguration<'line'> | null>(() => {
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
