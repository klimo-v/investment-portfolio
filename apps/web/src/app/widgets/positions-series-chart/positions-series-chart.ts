import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { ChartConfiguration } from 'chart.js';
import type { PositionSeries } from '@core';
import { chartSemantic, formatRub, seriesColor, ThemeService } from '@web-shared';
import { ChartCanvas } from '../chart-canvas/chart-canvas';

/**
 * «Стоимость инструментов во времени»: по линии на инструмент, жирная линия «Итого»
 * и пунктирная «Внесено (нетто)» — накопленный чистый ввод средств.
 *
 * Линия внесённого здесь не украшение: без неё рост «Итого» невозможно отличить от
 * простого довнесения капитала.
 */
@Component({
  selector: 'app-positions-series-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, ChartCanvas],
  template: `
    <mat-card>
      <h3>Стоимость инструментов во времени</h3>
      <p class="note">
        Стоимость каждого инструмента и итог по портфелю по датам снимков; пунктир —
        внесено (нетто): депозиты минус выводы, чтобы отделить рост от довнесения
        капитала. Сумма линий = «Текущая стоимость» портфеля. Снимки копятся при
        «Обновить цены» на странице «Портфель» (по одному в день).
        @if (segmented()) {
          Разбивка не делится по системам/портфелям — показан портфель целиком.
        }
      </p>
      @if (config(); as cfg) {
        <app-chart-canvas [config]="cfg" [tall]="true" />
      } @else {
        <p class="note">
          Снимков пока нет — они появляются на странице «Портфель» при нажатии
          «Обновить цены» (по одному снимку в день).
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
        margin: 0 0 12px;
        font-size: 13px;
        color: var(--app-text-muted);
      }
    `,
  ],
})
export class PositionsSeriesChart {
  /** Ряд из snapshot_positions; undefined — истории ещё нет */
  readonly series = input<PositionSeries | undefined>(undefined);
  readonly segmented = input(false);

  private readonly theme = inject(ThemeService);
  private readonly cc = computed(() => chartSemantic(this.theme.isDark()));

  protected readonly config = computed<ChartConfiguration<'line'> | null>(() => {
    const s = this.series();
    if (!s || s.dates.length === 0) return null;

    // spanGaps: false — null означает «в эту дату инструмент не удерживался»;
    // соединять такие точки линией значило бы рисовать несуществующую позицию
    const instrumentDatasets = s.instruments.map((ins, i) => ({
      label: ins.ticker,
      data: ins.values,
      borderColor: seriesColor(i),
      backgroundColor: seriesColor(i),
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.2,
      spanGaps: false,
    }));

    return {
      type: 'line',
      data: {
        labels: s.dates,
        datasets: [
          ...instrumentDatasets,
          {
            label: 'Итого',
            data: s.total,
            borderColor: this.cc().total,
            backgroundColor: this.cc().total,
            borderWidth: 2.5,
            pointRadius: 0,
            tension: 0.2,
          },
          {
            label: 'Внесено (нетто)',
            data: s.netContributions,
            borderColor: this.cc().neutral,
            backgroundColor: this.cc().neutral,
            borderWidth: 2,
            borderDash: [6, 4],
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
          legend: { display: true, position: 'bottom' },
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
