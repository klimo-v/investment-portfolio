import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { ChartConfiguration } from 'chart.js';
import { formatRub, StateMessage, ThemeService } from '@web-shared';
import { ChartCanvas } from '../chart-canvas/chart-canvas';

/** Доля распределения: подпись, стоимость в рублях и цвет сегмента */
export interface AllocationSlice {
  label: string;
  valueRub: number;
  color: string;
}

/**
 * Круговая диаграмма распределения текущей стоимости — по типам инструментов.
 * Сегменты с нулевой стоимостью отбрасываются: Chart.js рисует их как невидимые
 * полоски, но они занимают место в легенде и путают.
 */
@Component({
  selector: 'app-allocation-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, StateMessage, ChartCanvas],
  template: `
    <mat-card class="pie">
      <h3>{{ title() }}</h3>
      @if (config(); as cfg) {
        @if (unvaluedCount() > 0) {
          <p class="partial" role="status">
            Распределение по оценённым позициям · Без оценки: {{ unvaluedCount() }}
          </p>
        }
        <app-chart-canvas [config]="cfg" />
      } @else {
        <app-state-message kind="empty" icon="donut_large" [title]="emptyTitle()" />
      }
    </mat-card>
  `,
  styles: [
    `
      .pie {
        padding: 16px;
      }
      h3 {
        margin: 0 0 8px;
        font-weight: 500;
      }
    `,
  ],
})
export class AllocationChart {
  readonly title = input('Распределение');
  readonly unvaluedCount = input(0);
  readonly emptyTitle = input('Нет активов для распределения');
  readonly slices = input<readonly AllocationSlice[]>([]);

  private readonly theme = inject(ThemeService);

  protected readonly config = computed<ChartConfiguration<'doughnut'> | null>(() => {
    const data = this.slices().filter((s) => s.valueRub > 0);
    if (data.length === 0) return null;

    // Зависимость от темы обязательна: разделитель сегментов — JS-значение, уже
    // отрисованный график сам его не перечитает, конфиг должен пересобраться
    const dark = this.theme.isDark();

    return {
      type: 'doughnut',
      data: {
        labels: data.map((s) => s.label),
        datasets: [
          {
            data: data.map((s) => s.valueRub),
            backgroundColor: data.map((s) => s.color),
            // Разделитель цветом поверхности: без него соседние сегменты сливаются,
            // а на тёмном фоне белая рамка (дефолт Chart.js) выглядит как обводка
            borderColor: dark ? '#1c2020' : '#ffffff',
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: { callbacks: { label: (c) => `${c.label}: ${formatRub(Number(c.parsed))}` } },
        },
      },
    };
  });
}
