import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { ChartConfiguration } from 'chart.js';
import type { Yv1Overview } from '@core';
import { chartSemantic, StateMessage, ThemeService } from '@web-shared';
import { ChartCanvas } from '../chart-canvas/chart-canvas';

/**
 * Фактическая кривая ТС (net, доходность дня = net закрытых в этот день циклов к капиталу
 * на начало дня). Бэктест показываем справкой, а не второй линией: его кривая кончается
 * до начала живой торговли, общих дат нет, и две линии на одной оси читались бы как
 * сравнение, которого нет (сравнение — контрфактический прогон в репозитории стратегий).
 */
@Component({
  selector: 'app-yv1-equity-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, StateMessage, ChartCanvas],
  template: `
    <mat-card>
      <h3>Кривая капитала (факт, net)</h3>
      @if (config(); as cfg) {
        <app-chart-canvas [config]="cfg" />
      } @else {
        <app-state-message
          kind="empty"
          icon="show_chart"
          title="Кривой пока нет"
          hint="Нужны начальный капитал (знаменатель) и хотя бы один закрытый цикл."
        />
      }
      @if (backtest(); as bt) {
        <p class="note">
          Бэктест ЮВ1·2вх: {{ bt.points.length }} дней, последняя дата {{ bt.lastDate }}, номинал ×{{ bt.scale }}.
          Общих дат с живой торговлей нет — сравнение по циклам появится после контрфактического прогона.
        </p>
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
        margin: 12px 0 0;
        font-size: 13px;
        color: var(--app-text-muted);
      }
    `,
  ],
})
export class Yv1EquityChart {
  readonly curve = input<Yv1Overview['curve']>(null);
  readonly backtest = input<Yv1Overview['backtest']>(null);

  private readonly theme = inject(ThemeService);
  private readonly cc = computed(() => chartSemantic(this.theme.isDark()));

  protected readonly config = computed<ChartConfiguration<'line'> | null>(() => {
    const c = this.curve();
    if (!c || c.length === 0) return null;
    return {
      type: 'line',
      data: {
        labels: c.map((p) => p.date),
        datasets: [
          {
            label: 'Капитал ТС (факт, 1 = начало)',
            data: c.map((p) => p.equity),
            borderColor: this.cc().total,
            backgroundColor: this.cc().total,
            pointRadius: 3,
            tension: 0,
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
              label: (ctx) => {
                const p = c[ctx.dataIndex];
                return `equity ${p.equity.toFixed(5)} (день ${(p.ret * 100).toFixed(3)} %)`;
              },
            },
          },
        },
        scales: { x: { grid: { display: false } } },
      },
    };
  });
}
