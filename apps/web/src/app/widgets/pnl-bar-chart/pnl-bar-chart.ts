import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { ChartConfiguration } from 'chart.js';
import { chartSemantic, formatRub, StateMessage, ThemeService } from '@web-shared';
import { ChartCanvas } from '../chart-canvas/chart-canvas';

/** Одна колонка разреза: подпись и результат в рублях */
export interface PnlBar {
  label: string;
  pnlRub: number;
}

/**
 * P&L в разрезе: столбцы, цвет по знаку. Один виджет на два разных графика
 * дашборда — «P&L по системам» (вертикальные столбцы) и «Прибыль/убыток по
 * инструментам» (горизонтальные, потому что тикеров много и подписи не влезают в
 * ось X). Отличаются они ровно ориентацией и текстами, поэтому это вход, а не
 * второй компонент (DRY).
 */
@Component({
  selector: 'app-pnl-bar-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, StateMessage, ChartCanvas],
  template: `
    <mat-card>
      <h3>{{ title() }}</h3>
      @if (config(); as cfg) {
        <app-chart-canvas [config]="cfg" [tall]="horizontal()" />
      } @else {
        <app-state-message kind="empty" icon="bar_chart" [title]="emptyTitle()" [hint]="emptyHint()" />
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
export class PnlBarChart {
  readonly title = input.required<string>();
  readonly bars = input<readonly PnlBar[]>([]);
  /** Горизонтальные столбцы — когда подписей много и они длинные (тикеры) */
  readonly horizontal = input(false);
  readonly emptyTitle = input('Нет данных');
  readonly emptyHint = input('');

  private readonly theme = inject(ThemeService);
  private readonly cc = computed(() => chartSemantic(this.theme.isDark()));

  protected readonly config = computed<ChartConfiguration<'bar'> | null>(() => {
    const bars = this.bars();
    if (bars.length === 0) return null;

    const horizontal = this.horizontal();
    const moneyTicks = { callback: (v: string | number) => '₽' + Math.round(Number(v) / 1000) + 'k' };

    return {
      type: 'bar',
      data: {
        labels: bars.map((r) => r.label),
        datasets: [
          {
            label: 'P&L ₽',
            data: bars.map((r) => r.pnlRub),
            backgroundColor: bars.map((r) =>
              r.pnlRub >= 0 ? this.cc().positive : this.cc().negative,
            ),
            borderRadius: 3,
          },
        ],
      },
      options: {
        indexAxis: horizontal ? 'y' : 'x',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          // Легенда из одного ряда «P&L ₽» ничего не сообщает — цвет тут кодирует знак
          legend: { display: false },
          tooltip: {
            callbacks: { label: (c) => formatRub(horizontal ? c.parsed.x : c.parsed.y) },
          },
        },
        scales: horizontal ? { x: { ticks: moneyTicks } } : { y: { ticks: moneyTicks } },
      },
    };
  });
}
