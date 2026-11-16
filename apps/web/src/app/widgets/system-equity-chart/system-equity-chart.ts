import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import type { ChartConfiguration } from 'chart.js';
import type { SystemPerformance } from '@core';
import { chartSemantic, formatRub, StateMessage, ThemeService } from '@web-shared';
import { ChartCanvas } from '../chart-canvas/chart-canvas';

/** `trades` — по закрытым сделкам; `result` — результат системы (зафиксированное + «сегодня») */
export type EquityCurve = 'trades' | 'result';

/**
 * Кривая эквити системы (накопленный реализованный результат по дате закрытия сделок)
 * и просадка от пика заливкой. Нереализованный результат по открытой позиции сюда не
 * подмешивается — он показан отдельной плашкой.
 */
@Component({
  selector: 'app-system-equity-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatButtonToggleModule, StateMessage, ChartCanvas],
  template: `
    <mat-card>
      <div class="head">
        <h3>{{ curve() === 'result' ? 'Результат системы' : 'Эквити и просадка' }}</h3>
        <mat-button-toggle-group
          [value]="curve()"
          (change)="curveChange.emit($event.value)"
          hideSingleSelectionIndicator
          aria-label="Какая кривая показана"
        >
          <mat-button-toggle value="result">Результат системы</mat-button-toggle>
          <mat-button-toggle value="trades">Закрытые сделки</mat-button-toggle>
        </mat-button-toggle-group>
      </div>
      <p class="note">{{ note() }}</p>
      @if (periodNote()) {
        <p class="note">{{ periodNote() }}</p>
      }
      @if (config(); as cfg) {
        <!--
          Холст пересоздаётся при смене кривой (track по режиму). ng2-charts при смене
          конфигурации обновляет график «на месте» (Object.assign поверх старого
          config.options/data): у двух режимов разные оси и подсказки, и остатки прежнего
          режима оставляли на экране старую кривую после переключения обратно.
        -->
        @for (mode of [curve()]; track mode) {
          <app-chart-canvas [config]="cfg" />
        }
      } @else {
        <app-state-message kind="empty" icon="show_chart" title="Нет данных" [hint]="emptyHint()" />
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
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      h3 {
        margin: 0 0 8px;
        font-weight: 500;
      }
      .note {
        margin: 0 0 8px;
        font-size: 13px;
        color: var(--app-text-muted);
      }
    `,
  ],
})
export class SystemEquityChart {
  readonly performance = input.required<SystemPerformance>();
  readonly curve = input<EquityCurve>('result');
  /** Выбран период: кривая «Результат системы» идёт от нуля на его начало; даты — для подписи */
  readonly periodFrom = input<string | null>(null);
  readonly periodTill = input<string | null>(null);
  readonly curveChange = output<EquityCurve>();

  protected readonly periodNote = computed(() => {
    const from = this.periodFrom();
    const till = this.periodTill();
    if (this.curve() !== 'result' || (!from && !till)) return '';
    const parts: string[] = [];
    if (from) parts.push(`Результат считается относительно начала дня ${from}.`);
    if (till) parts.push(`Конец периода — ${till}.`);
    return parts.join(' ');
  });

  protected readonly note = computed(() =>
    this.curve() === 'result'
      ? 'Зафиксированное (все продажи, в т.ч. частичные; дивиденды и купоны; за вычетом налогов и комиссий) плюс переоценка остатка по цене дня. Янтарные точки — дни, где цена не найдена или взята от более ранней даты. Просадка — от пика кривой.'
      : 'Накопленный результат по дате закрытия каждой сделки. Показывает качество входов и выходов, без дивидендов и открытых позиций.',
  );
  protected readonly emptyHint = computed(() =>
    this.curve() === 'result' ? 'Кривая появится после первой операции.' : 'Кривая появится после первой закрытой сделки.',
  );

  private readonly theme = inject(ThemeService);
  private readonly cc = computed(() => chartSemantic(this.theme.isDark()));

  protected readonly config = computed<ChartConfiguration<'line'> | null>(() =>
    this.curve() === 'result' ? this.resultConfig() : this.tradesConfig(),
  );

  /**
   * Результат системы: точка на каждый день (зафиксированное + переоценка остатка по цене дня).
   * Дни, где цена не найдена или взята от более ранней даты, отмечены янтарным маркером с
   * пояснением в подсказке: линия на них — не оценка по рынку этого дня.
   */
  private readonly resultConfig = computed<ChartConfiguration<'line'> | null>(() => {
    const points = this.performance().series.result;
    if (!points.length) return null;
    const cc = this.cc();
    const flagged = (i: number): boolean => points[i].carried.length > 0;
    const describe = (c: SystemPerformance['series']['result'][number]['carried'][number]): string => {
      if (c.reason === 'no-price') return `${c.instrumentId}: цена на дату не найдена, остаток оценён по себестоимости`;
      if (c.reason === 'no-fx') return `${c.instrumentId}: нет курса валюты цены, остаток оценён по себестоимости`;
      return `${c.instrumentId}: цена на дату не найдена, взята от ${c.priceDate}`;
    };
    return {
      type: 'line',
      data: {
        labels: points.map((p) => p.date),
        datasets: [
          {
            label: 'Результат, ₽',
            data: points.map((p) => Number(p.totalRub)),
            borderColor: cc.total,
            backgroundColor: cc.total,
            pointRadius: (c) => (flagged(c.dataIndex) || points.length === 1 ? 3 : 0),
            pointHoverRadius: 4,
            pointBackgroundColor: (c) => (flagged(c.dataIndex) ? cc.benchmark : cc.total),
            pointBorderColor: (c) => (flagged(c.dataIndex) ? cc.benchmark : cc.total),
            tension: 0,
          },
          {
            label: 'Просадка, ₽',
            data: points.map((p) => Number(p.drawdownRub)),
            borderColor: cc.negative,
            backgroundColor: cc.negative + '55',
            fill: 'origin',
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
          tooltip: {
            callbacks: {
              label: (c) => `${c.dataset.label}: ${formatRub(c.parsed.y)}`,
              afterBody: (items) => {
                const p = items.length > 0 ? points[items[0].dataIndex] : undefined;
                if (!p) return [];
                const lines = [`зафиксировано ${formatRub(Number(p.fixedRub))}, переоценка ${formatRub(Number(p.unrealizedRub))}`];
                return [...lines, ...p.carried.map(describe)];
              },
            },
          },
        },
        scales: { y: { ticks: { callback: (v) => formatRub(Number(v)) } } },
      },
    };
  });

  private readonly tradesConfig = computed<ChartConfiguration<'line'> | null>(() => {
    const points = this.performance().series.equity;
    if (points.length < 2) return null;
    const cc = this.cc();
    return {
      type: 'line',
      data: {
        labels: points.map((p) => p.date),
        datasets: [
          {
            label: 'Эквити, ₽',
            data: points.map((p) => Number(p.equityRub)),
            borderColor: cc.total,
            backgroundColor: cc.total,
            pointRadius: 3,
            tension: 0,
          },
          {
            label: 'Просадка, ₽',
            data: points.map((p) => Number(p.drawdownRub)),
            borderColor: cc.negative,
            backgroundColor: cc.negative + '55',
            fill: 'origin',
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
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${formatRub(c.parsed.y)}` } },
        },
        scales: { y: { ticks: { callback: (v) => formatRub(Number(v)) } } },
      },
    };
  });
}
