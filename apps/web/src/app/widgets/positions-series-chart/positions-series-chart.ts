import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { ChartConfiguration } from 'chart.js';
import type { ValuationSeriesDto } from '@core';
import { chartSemantic, formatRub, seriesColor, ThemeService } from '@web-shared';
import { ChartCanvas } from '../chart-canvas/chart-canvas';

/**
 * «Стоимость инструментов во времени»: стек позиций по инструментам плюс верхний слой «Деньги»;
 * вершина стека — богатство (позиции + кэш), его повторяет жирная линия «Итого». Пунктир —
 * «Внесено (нетто)» (накопленный чистый ввод), чтобы отделить рост от довнесения.
 *
 * Продажа переливает стоимость из слоя бумаги в слой «Деньги», а выплата добавляет в него, поэтому
 * вершина стека не проваливается там, где деньги просто ждут новой покупки. Маркеры на оси
 * времени — выплаты (▲) и продажи (◆); сумма и бумага — в подсказке.
 *
 * Без кэша (фильтр по системе) слоя «Деньги» нет: деньги от продаж и выплат уходят в общий кэш
 * счёта — об этом подпись под графиком.
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
        Стек: стоимость каждого инструмента, сверху — «Деньги» (свободный кэш счёта). Продажа
        переливает стоимость в «Деньги», выплата добавляет в них, поэтому «Итого» (позиции + деньги)
        не падает, пока деньги ждут новой покупки. Пунктир — внесено (нетто): депозиты минус выводы.
        ▲ — выплата, ◆ — продажа (сумма в подсказке). Янтарные точки на «Итого» — дни, где цена
        инструмента не найдена или взята от более ранней даты.
      </p>
      @if (series(); as s) {
        @if (!s.hasCash && s.groups.length > 0) {
          <p class="note">
            Слоя «Деньги» нет: у системы/инструмента нет своего кэша — деньги от продаж и выплат уходят в общий
            кэш портфеля, поэтому линия «Итого» здесь падает при каждой продаже. Выплаты и продажи отмечены маркерами.
          </p>
        }
      }
      @if (negativeCash()) {
        <p class="note warn">
          Кэш по журналу отрицательный: в журнале не хватает ввода денег (пополнений или переводов), слой «Деньги»
          уходит ниже нуля.
        </p>
      }
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
      .warn {
        color: var(--app-negative, #c0392b);
      }
    `,
  ],
})
export class PositionsSeriesChart {
  /** Дневной ряд по инструментам; undefined — ещё не загружен */
  readonly series = input<ValuationSeriesDto | undefined>(undefined);

  private readonly theme = inject(ThemeService);
  private readonly cc = computed(() => chartSemantic(this.theme.isDark()));

  /** Вычисленный кэш ушёл ниже нуля — сигнал неполноты журнала (подробный список — этап «Полнота журнала») */
  protected readonly negativeCash = computed(() => (this.series()?.cashRub ?? []).some((c) => Number(c) < -0.005));

  protected readonly config = computed<ChartConfiguration<'line'> | null>(() => {
    const s = this.series();
    const groups = s?.groups ?? [];
    if (!s || groups.length === 0 || groups[0].points.length === 0) return null;
    const dates = groups[0].points.map((p) => p.date);

    // null — в эту дату инструмент не удерживался (нет ни вложений, ни стоимости): соединять
    // такие точки линией значило бы рисовать несуществующую позицию
    // стек: «не удерживался» = 0 (в стеке пропуск рвал бы слои), поэтому слой просто не виден
    const alpha = (color: string): string => (/^#[0-9a-f]{6}$/i.test(color) ? `${color}99` : color);
    const instrumentDatasets = groups.map((g, i) => ({
      label: g.name,
      data: g.points.map((p) => Number(p.marketValueRub)),
      borderColor: seriesColor(i),
      backgroundColor: alpha(seriesColor(i)),
      borderWidth: 1,
      pointRadius: 0,
      tension: 0.2,
      fill: true,
      stack: 'positions',
    }));

    const positions = dates.map((_, i) => groups.reduce((sum, g) => sum + Number(g.points[i].marketValueRub), 0));
    const cash = s.hasCash ? s.cashRub.map(Number) : [];
    // вершина стека: позиции + деньги (богатство); без кэша — только позиции
    const total = positions.map((v, i) => v + (cash[i] ?? 0));

    // маркеры событий — на вершине стека в день события
    const dayIndex = new Map(dates.map((d, i) => [d, i]));
    const eventsByIndex = new Map<number, string[]>();
    const markers = (kind: 'payout' | 'sale'): (number | null)[] => {
      const data: (number | null)[] = dates.map(() => null);
      for (const e of s.events) {
        const i = dayIndex.get(e.date);
        if (i === undefined || e.kind !== kind) continue;
        data[i] = total[i];
        const line = `${kind === 'payout' ? '▲ выплата' : '◆ продажа'} ${e.name}: ${formatRub(Number(e.amountRub))}`;
        eventsByIndex.set(i, [...(eventsByIndex.get(i) ?? []), line]);
      }
      return data;
    };
    const payoutMarkers = markers('payout');
    const saleMarkers = markers('sale');
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
          ...(s.hasCash
            ? [
                {
                  label: 'Деньги',
                  data: cash,
                  borderColor: this.cc().neutral,
                  backgroundColor: alpha(this.cc().neutral),
                  borderWidth: 1,
                  pointRadius: 0,
                  tension: 0,
                  fill: true,
                  stack: 'positions',
                },
              ]
            : []),
          {
            label: s.hasCash ? 'Итого (позиции + деньги)' : 'Итого (позиции)',
            data: total,
            borderColor: this.cc().total,
            backgroundColor: this.cc().total,
            borderWidth: 2.5,
            stack: 'total',
            pointRadius: (c) => (flagged[c.dataIndex] ? 3 : 0),
            pointBackgroundColor: (c) => (flagged[c.dataIndex] ? this.cc().benchmark : this.cc().total),
            pointBorderColor: (c) => (flagged[c.dataIndex] ? this.cc().benchmark : this.cc().total),
            tension: 0.2,
          },
          ...(s.hasCash
            ? [
                {
                  label: 'Внесено (нетто)',
                  data: s.netContributionsRub.map(Number),
                  borderColor: this.cc().neutral,
                  backgroundColor: this.cc().neutral,
                  borderWidth: 2,
                  borderDash: [6, 4],
                  pointRadius: 0,
                  tension: 0,
                  stack: 'net',
                },
              ]
            : []),
          {
            label: '▲ Выплата',
            data: payoutMarkers,
            showLine: false,
            borderColor: this.cc().total,
            backgroundColor: this.cc().benchmark,
            pointStyle: 'triangle' as const,
            pointRadius: 6,
            pointHoverRadius: 8,
            stack: 'ev-payout',
          },
          {
            label: '◆ Продажа',
            data: saleMarkers,
            showLine: false,
            borderColor: this.cc().total,
            backgroundColor: this.cc().deposit,
            pointStyle: 'rectRot' as const,
            pointRadius: 5,
            pointHoverRadius: 7,
            stack: 'ev-sale',
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
            // строки маркеров в списке значений не нужны: события перечислены отдельным блоком ниже
            filter: (item) => !item.dataset.label?.startsWith('▲') && !item.dataset.label?.startsWith('◆'),
            callbacks: {
              label: (c) => `${c.dataset.label}: ${formatRub(c.parsed.y)}`,
              afterBody: (items) =>
                items.length > 0 ? [...(eventsByIndex.get(items[0].dataIndex) ?? []), ...carriedAt(items[0].dataIndex)] : [],
            },
          },
        },
        scales: {
          x: { grid: { display: false } },
          y: { stacked: true, ticks: { callback: (v) => '₽' + Math.round(Number(v) / 1000) + 'k' } },
        },
      },
    };
  });
}
