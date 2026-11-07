import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { ChartConfiguration } from 'chart.js';
import type { ValuationSeriesDto } from '@core';
import { chartSemantic, formatRub, seriesColor, ThemeService } from '@web-shared';
import { ChartCanvas } from '../chart-canvas/chart-canvas';

/**
 * «Стоимость инструментов во времени»: по линии на инструмент, жирная линия «Итого»
 * и пунктирная «Внесено (нетто)» — накопленный чистый ввод средств.
 *
 * Линия внесённого здесь не украшение: без неё рост «Итого» невозможно отличить от
 * простого довнесения капитала.
 *
 * Данные — дневной ряд оценки (valuationSeries, groupBy=instrument), считается из журнала
 * операций и истории цен: точка на каждый день, без кнопки «Сделать снимок». Дни, где цена
 * инструмента не найдена или взята от более ранней даты, отмечены на «Итого» и описаны в
 * подсказке. Виджет презентационный (FSD): сюда приходят только данные.
 */
@Component({
  selector: 'app-positions-series-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, ChartCanvas],
  template: `
    <mat-card>
      <h3>Стоимость инструментов во времени</h3>
      <p class="note">
        Стоимость каждого инструмента и итог по портфелю по дням; пунктир — внесено (нетто):
        депозиты минус выводы, чтобы отделить рост от довнесения капитала. Сумма линий =
        «Текущая стоимость» портфеля. Янтарные точки на «Итого» — дни, где цена инструмента не
        найдена или взята от более ранней даты (подробности в подсказке).
      </p>
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
  /** Дневной ряд по инструментам; undefined — ещё не загружен */
  readonly series = input<ValuationSeriesDto | undefined>(undefined);

  private readonly theme = inject(ThemeService);
  private readonly cc = computed(() => chartSemantic(this.theme.isDark()));

  protected readonly config = computed<ChartConfiguration<'line'> | null>(() => {
    const s = this.series();
    const groups = s?.groups ?? [];
    if (!s || groups.length === 0 || groups[0].points.length === 0) return null;
    const dates = groups[0].points.map((p) => p.date);

    // null — в эту дату инструмент не удерживался (нет ни вложений, ни стоимости): соединять
    // такие точки линией значило бы рисовать несуществующую позицию
    const instrumentDatasets = groups.map((g, i) => ({
      label: g.name,
      data: g.points.map((p) =>
        Number(p.marketValueRub) === 0 && Number(p.investedRub) === 0 ? null : Number(p.marketValueRub),
      ),
      borderColor: seriesColor(i),
      backgroundColor: seriesColor(i),
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.2,
      spanGaps: false,
    }));

    const total = dates.map((_, i) => groups.reduce((sum, g) => sum + Number(g.points[i].marketValueRub), 0));
    // что именно подменено на день: по инструментам из групп (уникальные пары, без дублей)
    const carriedAt = (i: number): string[] => {
      const seen = new Set<string>();
      for (const g of groups) {
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

    return {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          ...instrumentDatasets,
          {
            label: 'Итого',
            data: total,
            borderColor: this.cc().total,
            backgroundColor: this.cc().total,
            borderWidth: 2.5,
            pointRadius: (c) => (flagged[c.dataIndex] ? 3 : 0),
            pointBackgroundColor: (c) => (flagged[c.dataIndex] ? this.cc().benchmark : this.cc().total),
            pointBorderColor: (c) => (flagged[c.dataIndex] ? this.cc().benchmark : this.cc().total),
            tension: 0.2,
          },
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
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, position: 'bottom' },
          tooltip: {
            callbacks: {
              label: (c) => `${c.dataset.label}: ${formatRub(c.parsed.y)}`,
              afterBody: (items) => (items.length > 0 ? carriedAt(items[0].dataIndex) : []),
            },
          },
        },
        scales: {
          x: { grid: { display: false } },
          y: { ticks: { callback: (v) => '₽' + Math.round(Number(v) / 1000) + 'k' } },
        },
      },
    };
  });
}
