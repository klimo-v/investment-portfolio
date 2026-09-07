import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { ChartConfiguration } from 'chart.js';
import type { BenchmarkPoint, Snapshot } from '@core';
import { chartSemantic, seriesColor, ThemeService } from '@web-shared';
import { ChartCanvas } from '../chart-canvas/chart-canvas';

/**
 * Годовая ставка вклада-ориентира для линии «Депозит» (что было бы, положи те же
 * деньги на вклад). Допущение — при желании выносится в настройки; ориентир —
 * ключевая ставка периода.
 */
const DEPOSIT_ANNUAL_RATE = 0.16;

/**
 * «Портфель против рынка»: рост ₽100, вложенных в начале периода — портфель (по
 * снимкам стоимости), индекс МосБиржи и вклад под фиксированную ставку.
 *
 * Нормировка на 100 обязательна: абсолютные рубли портфеля и пункты индекса
 * несопоставимы, а вопрос «обгоняю ли я рынок» — именно про относительный рост.
 */
@Component({
  selector: 'app-benchmark-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, ChartCanvas],
  template: `
    <mat-card>
      <h3>Портфель против рынка</h3>
      <p class="note">
        Рост ₽100, вложенных в начале периода: ваш портфель, индекс МосБиржи (IMOEX)
        и вклад под {{ depositRatePct }}% годовых. По снимкам стоимости.
        @if (segmented()) {
          Снимки не разбиты по системам/портфелям — график показывает портфель целиком.
        }
      </p>
      @if (config(); as cfg) {
        <app-chart-canvas [config]="cfg" />
      } @else {
        <p class="note">
          Нужно минимум два снимка стоимости и данные индекса. Снимки снимаются
          кнопкой «Сделать снимок» у графика «Стоимость инструментов во времени».
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
export class BenchmarkChart {
  /** Снимки по возрастанию даты, уже обрезанные под выбранный период */
  readonly snapshots = input.required<readonly Snapshot[]>();
  /** История индекса; порядок неважен — сортируется здесь */
  readonly points = input<readonly BenchmarkPoint[]>([]);
  /** Выбран конкретный система/портфель — снимки их не различают, предупреждаем */
  readonly segmented = input(false);

  private readonly theme = inject(ThemeService);
  private readonly cc = computed(() => chartSemantic(this.theme.isDark()));

  protected readonly depositRatePct = (DEPOSIT_ANNUAL_RATE * 100).toFixed(0);

  /** null — данных для сравнения недостаточно */
  protected readonly config = computed<ChartConfiguration<'line'> | null>(() => {
    const s = this.snapshots();
    const b = [...this.points()].sort((a, b) => a.date.localeCompare(b.date));
    if (s.length < 2 || b.length === 0) return null;

    const baseValue = s[0].currentValueRub > 0 ? s[0].currentValueRub : s[0].investedRub;
    if (baseValue <= 0) return null;

    // Индекс торгуется не каждый день, снимки снимаются не каждый торговый день:
    // выравниваем по «последнему закрытию на дату или раньше»
    const closeOnOrBefore = (date: string): number => {
      let close = b[0].close;
      for (const p of b) {
        if (p.date <= date) close = p.close;
        else break;
      }
      return close;
    };
    const baseClose = closeOnOrBefore(s[0].date);
    const baseTime = new Date(s[0].date + 'T00:00:00Z').getTime();
    const dayMs = 24 * 60 * 60 * 1000;

    const portfolio = s.map((r) => (r.currentValueRub / baseValue) * 100);
    const imoex = s.map((r) => (closeOnOrBefore(r.date) / baseClose) * 100);
    const deposit = s.map((r) => {
      const years = (new Date(r.date + 'T00:00:00Z').getTime() - baseTime) / dayMs / 365;
      return 100 * Math.pow(1 + DEPOSIT_ANNUAL_RATE, years);
    });

    return {
      type: 'line',
      data: {
        labels: s.map((r) => r.date),
        datasets: [
          {
            label: 'Портфель',
            data: portfolio,
            borderColor: seriesColor(0),
            backgroundColor: seriesColor(0),
            pointRadius: 2,
            tension: 0.2,
          },
          {
            label: 'IMOEX',
            data: imoex,
            borderColor: this.cc().benchmark,
            backgroundColor: this.cc().benchmark,
            pointRadius: 2,
            tension: 0.2,
          },
          {
            label: 'Депозит',
            data: deposit,
            borderColor: this.cc().deposit,
            backgroundColor: this.cc().deposit,
            pointRadius: 0,
            borderDash: [6, 4],
            tension: 0,
          },
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
