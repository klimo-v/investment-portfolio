import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { ChartConfiguration } from 'chart.js';
import type { PositionSeries, SnapshotStaleness } from '@core';
import { chartSemantic, formatRub, seriesColor, ThemeService } from '@web-shared';
import { ChartCanvas } from '../chart-canvas/chart-canvas';

/**
 * «Стоимость инструментов во времени»: по линии на инструмент, жирная линия «Итого»
 * и пунктирная «Внесено (нетто)» — накопленный чистый ввод средств.
 *
 * Линия внесённого здесь не украшение: без неё рост «Итого» невозможно отличить от
 * простого довнесения капитала.
 *
 * Виджет остаётся презентационным (FSD): снимок снимает и модалку открывает страница,
 * сюда приходят только данные и уходят события.
 */
@Component({
  selector: 'app-positions-series-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatCardModule, MatIconModule, MatTooltipModule, ChartCanvas],
  template: `
    <mat-card>
      <div class="head">
        <h3>Стоимость инструментов во времени</h3>
        @if (stale()) {
          <button
            type="button"
            mat-icon-button
            class="stale"
            [matTooltip]="staleTooltip()"
            [attr.aria-label]="staleTooltip()"
            (click)="showChanges.emit()"
          >
            <mat-icon>warning</mat-icon>
          </button>
        }
        <span class="spacer"></span>
        <button type="button" mat-stroked-button [disabled]="capturing()" (click)="capture.emit()">
          {{ capturing() ? 'Сохраняем…' : 'Сделать снимок' }}
        </button>
      </div>
      <p class="note">
        Стоимость каждого инструмента и итог по портфелю по датам снимков; пунктир —
        внесено (нетто): депозиты минус выводы, чтобы отделить рост от довнесения
        капитала. Сумма линий = «Текущая стоимость» портфеля. Точка на графике
        появляется по кнопке «Сделать снимок» (одна на день — повторный снимок
        обновит сегодняшнюю).
        @if (segmented()) {
          Разбивка не делится по системам/портфелям — показан портфель целиком.
        }
      </p>
      @if (config(); as cfg) {
        <app-chart-canvas [config]="cfg" [tall]="true" />
      } @else {
        <p class="note">
          Снимков пока нет — нажмите «Сделать снимок», чтобы зафиксировать текущую
          стоимость инструментов. Дальше история копится от снимка к снимку.
        </p>
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
        align-items: center;
        gap: 4px;
        margin-bottom: 8px;
      }
      .spacer {
        flex: 1;
      }
      h3 {
        margin: 0;
        font-weight: 500;
      }
      .stale {
        color: var(--app-warn);
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
  /** Достоверность истории снимков; null — ещё не загружена */
  readonly staleness = input<SnapshotStaleness | null>(null);
  /** Снимок сохраняется прямо сейчас — блокируем повторный клик */
  readonly capturing = input(false);

  /** Снять снимок текущей стоимости */
  readonly capture = output<void>();
  /** Показать таблицу изменений, из-за которых снимкам нельзя доверять */
  readonly showChanges = output<void>();

  protected readonly stale = computed(() => this.staleness()?.stale === true);

  protected readonly staleTooltip = computed(() => {
    const since = this.staleness()?.staleSince;
    const scope = since ? `Снимкам с ${since}` : 'Снимкам';
    return `${scope} доверять нельзя: журнал операций изменился задним числом. Нажмите, чтобы посмотреть, что именно изменилось.`;
  });

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
