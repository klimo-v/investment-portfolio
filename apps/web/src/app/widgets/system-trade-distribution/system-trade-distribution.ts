import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { ChartConfiguration } from 'chart.js';
import type { SystemPerformance } from '@core';
import { chartSemantic, formatRub, StateMessage, ThemeService } from '@web-shared';
import { ChartCanvas } from '../chart-canvas/chart-canvas';

/** Гистограмма результатов закрытых сделок: сколько сделок попало в каждый интервал ₽ */
@Component({
  selector: 'app-system-trade-distribution',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, StateMessage, ChartCanvas],
  template: `
    <mat-card>
      <h3>Распределение результатов сделок</h3>
      @if (config(); as cfg) {
        <app-chart-canvas [config]="cfg" />
      } @else {
        <app-state-message kind="empty" icon="bar_chart" title="Нет закрытых сделок" hint="Гистограмма появится после первой закрытой сделки." />
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
export class SystemTradeDistribution {
  readonly performance = input.required<SystemPerformance>();

  private readonly theme = inject(ThemeService);
  private readonly cc = computed(() => chartSemantic(this.theme.isDark()));

  protected readonly config = computed<ChartConfiguration<'bar'> | null>(() => {
    const bins = this.performance().series.histogram;
    if (bins.length === 0) return null;
    const cc = this.cc();
    // цвет по середине интервала: интервалы левее нуля — убыточные
    const mid = (b: (typeof bins)[number]) => (Number(b.fromRub) + Number(b.toRub)) / 2;
    return {
      type: 'bar',
      data: {
        labels: bins.map((b) => `${formatRub(Number(b.fromRub))} … ${formatRub(Number(b.toRub))}`),
        datasets: [
          {
            label: 'Сделок',
            data: bins.map((b) => b.count),
            backgroundColor: bins.map((b) => (mid(b) >= 0 ? cc.positive : cc.negative)),
            borderRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { ticks: { precision: 0 } } },
      },
    };
  });
}
