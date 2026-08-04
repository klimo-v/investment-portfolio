import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { ChartConfiguration } from 'chart.js';
import type { DashboardSummary } from '@core';
import { chartSemantic, formatRub, StateMessage, ThemeService } from '@web-shared';
import { ChartCanvas } from '../chart-canvas/chart-canvas';

type TimelinePoint = DashboardSummary['timeline'][number];

/**
 * «Поток и доход по месяцам»: столбцы движения кэша (депозиты/выводы) и полученного
 * дохода (дивиденды/купоны) на одной оси — видно, чем месяц был: довнесением или
 * заработком.
 */
@Component({
  selector: 'app-cashflow-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, StateMessage, ChartCanvas],
  template: `
    <mat-card>
      <h3>Поток и доход по месяцам</h3>
      <p class="note">
        Столбцы на одной оси: поток кэша (депозиты/выводы) и доход (дивиденды/купоны).
      </p>
      @if (config(); as cfg) {
        <app-chart-canvas [config]="cfg" />
      } @else {
        <app-state-message
          kind="empty"
          icon="bar_chart"
          title="Нет движений за период"
          hint="Здесь появятся депозиты, выводы и полученные дивиденды по месяцам."
        />
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
      .note {
        margin: 0 0 12px;
        font-size: 13px;
        color: var(--app-text-muted);
      }
    `,
  ],
})
export class CashflowChart {
  readonly timeline = input<readonly TimelinePoint[]>([]);

  private readonly theme = inject(ThemeService);
  private readonly cc = computed(() => chartSemantic(this.theme.isDark()));

  protected readonly config = computed<ChartConfiguration<'bar'> | null>(() => {
    const t = this.timeline();
    if (t.length === 0) return null;
    return {
      type: 'bar',
      data: {
        labels: t.map((r) => r.period),
        datasets: [
          {
            label: 'Поток',
            data: t.map((r) => r.flow),
            backgroundColor: this.cc().neutral,
            borderRadius: 3,
          },
          {
            label: 'Доход',
            // Цвет по знаку КАЖДОГО столбца, а не всего ряда: месяц с отрицательным
            // доходом (возврат налога, корректировка) должен читаться сразу
            data: t.map((r) => r.income),
            backgroundColor: t.map((r) =>
              r.income >= 0 ? this.cc().positive : this.cc().negative,
            ),
            borderRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${formatRub(c.parsed.y)}` } },
        },
        scales: {
          x: { grid: { display: false } },
          y: { ticks: { callback: (v) => '₽' + Math.round(Number(v) / 1000) + 'k' } },
        },
      },
    };
  });
}
