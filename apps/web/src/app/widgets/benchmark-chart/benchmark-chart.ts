import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import type { ChartConfiguration } from 'chart.js';
import { BENCHMARK_INDEXES, type BenchmarkResponse } from '@core';
import { chartSemantic, seriesColor, ThemeService } from '@web-shared';
import { ChartCanvas } from '../chart-canvas/chart-canvas';

/**
 * «Портфель против рынка»: доходность стратегии (TWR, без ваших вводов и выводов), выбранный
 * ориентир и денежный рынок на базе 100 в первый день периода.
 *
 * Нормировка на 100 обязательна: рубли портфеля и пункты индекса несопоставимы, а вопрос
 * «обгоняю ли я рынок» — про относительный рост. Все три ряда приходят готовыми с бэка
 * (портфель — из /api/performance, ориентир — из /api/benchmark), на фронте ничего не
 * пересчитывается: последняя точка линии «Портфель» совпадает с карточкой TWR.
 *
 * Ориентир по умолчанию — индекс МосБиржи полной доходности (нетто): дивиденды портфеля сравниваются
 * с индексом, в котором дивиденды тоже есть. IMOEX (ценовой) остаётся выбираемым с пометкой.
 */
@Component({
  selector: 'app-benchmark-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatFormFieldModule, MatSelectModule, ChartCanvas],
  template: `
    <mat-card>
      <div class="head">
        <h3>Портфель против рынка</h3>
        <mat-form-field appearance="outline" subscriptSizing="dynamic" class="picker">
          <mat-label>Ориентир</mat-label>
          <mat-select [value]="selected()" (valueChange)="selectedChange.emit($event)">
            @for (b of options; track b.secid) {
              <mat-option [value]="b.secid">{{ b.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      </div>
      <p class="note">
        Рост ₽100 на начало периода: доходность вашей стратегии (TWR — без учёта ваших вводов и выводов),
        выбранный ориентир и денежный рынок (RUSFAR).
        @if (note(); as n) {
          {{ n }}
        }
      </p>
      @if (config(); as cfg) {
        <app-chart-canvas [config]="cfg" />
      } @else {
        <p class="note">Нужно минимум два дня истории портфеля.</p>
      }
      @if (benchmark() && !benchmark()?.index) {
        <p class="note warn">Ряд выбранного ориентира не загружен (источник MOEX недоступен) — показаны портфель и денежный рынок.</p>
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
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 8px;
      }
      h3 {
        margin: 0;
        font-weight: 500;
      }
      .picker {
        min-width: 260px;
      }
      .note {
        margin: 0 0 12px;
        font-size: 13px;
        color: var(--app-text-muted);
      }
      .warn {
        margin: 12px 0 0;
      }
    `,
  ],
})
export class BenchmarkChart {
  /** Индекс доходности портфеля (TWR, база 100 в первый день), по возрастанию даты */
  readonly values = input.required<readonly { date: string; valueRub: number }[]>();
  /** Выбранный индекс и денежный рынок на той же базе; undefined — ещё грузится */
  readonly benchmark = input<BenchmarkResponse | undefined>(undefined);
  readonly selected = input.required<string>();
  readonly selectedChange = output<string>();

  protected readonly options = BENCHMARK_INDEXES;

  private readonly theme = inject(ThemeService);
  private readonly cc = computed(() => chartSemantic(this.theme.isDark()));

  protected readonly note = computed(() => this.benchmark()?.index?.note ?? '');

  /** null — данных для сравнения недостаточно */
  protected readonly config = computed<ChartConfiguration<'line'> | null>(() => {
    const s = this.values();
    if (s.length < 2) return null;
    const labels = s.map((r) => r.date);
    const byDate = (series: { date: string; index: number }[] | undefined): (number | null)[] => {
      const map = new Map((series ?? []).map((p) => [p.date, p.index]));
      return labels.map((d) => map.get(d) ?? null);
    };
    const b = this.benchmark();
    const index = b?.index;
    const money = b?.moneyMarket;

    return {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Портфель (TWR)',
            data: s.map((r) => r.valueRub),
            borderColor: seriesColor(0),
            backgroundColor: seriesColor(0),
            pointRadius: 2,
            tension: 0.2,
          },
          ...(index
            ? [
                {
                  label: index.secid,
                  data: byDate(index.series),
                  borderColor: this.cc().benchmark,
                  backgroundColor: this.cc().benchmark,
                  pointRadius: 2,
                  tension: 0.2,
                },
              ]
            : []),
          ...(money
            ? [
                {
                  label: 'Денежный рынок (RUSFAR)',
                  data: byDate(money.series),
                  borderColor: this.cc().deposit,
                  backgroundColor: this.cc().deposit,
                  pointRadius: 0,
                  borderDash: [6, 4],
                  tension: 0,
                },
              ]
            : []),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true },
          tooltip: {
            callbacks: { label: (c) => `${c.dataset.label}: ${Number(c.parsed.y).toFixed(1)}` },
          },
        },
        scales: {
          x: { grid: { display: false } },
          y: { ticks: { callback: (v) => Number(v).toFixed(0) } },
        },
      },
    };
  });
}
