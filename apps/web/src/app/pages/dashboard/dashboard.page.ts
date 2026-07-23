import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { BaseChartDirective } from 'ng2-charts';
import type { ChartConfiguration } from 'chart.js';
import { OperationApi } from '../../entities/operation/operation.api';
import { formatMoney, pnlColorClass } from '@web-shared';

/**
 * Дашборд (docs/03-ux-plan.md, шаг 4).
 * Логика построения графиков — из portfolio_dashboard.html пользователя:
 * комбо-график с двумя осями (поток/доход столбцами), цвет по знаку, палитра C.
 * Данные — из нашего API (/api/operations/summary), не импортируются вручную.
 */

/** Палитра из portfolio_dashboard.html */
const C = {
  blue: '#2a78d6',
  gray: '#888780',
  green: '#199e70',
  greenT: '#1baf7a',
  red: '#e34948',
};

@Component({
  selector: 'app-dashboard-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, BaseChartDirective],
  template: `
    <h1 class="page-title">Дашборд</h1>

    @if (api.summary.isLoading()) {
      <p>Загрузка…</p>
    } @else if (api.summary.error()) {
      <p class="error">Не удалось загрузить сводку. Запущен ли API?</p>
    } @else {
      <div class="totals">
        <mat-card>
          <mat-card-subtitle>Вложено</mat-card-subtitle>
          <mat-card-title>{{ money(totals().investedRub) }}</mat-card-title>
        </mat-card>
        <mat-card>
          <mat-card-subtitle>Текущая стоимость</mat-card-subtitle>
          <mat-card-title>{{ money(totals().currentValueRub) }}</mat-card-title>
        </mat-card>
        <mat-card>
          <mat-card-subtitle>P&L</mat-card-subtitle>
          <mat-card-title [class]="cls(totals().pnlRub)">{{ money(totals().pnlRub) }}</mat-card-title>
        </mat-card>
        <mat-card>
          <mat-card-subtitle>Дивиденды + купоны</mat-card-subtitle>
          <mat-card-title>{{ money(totals().dividendsRub) }}</mat-card-title>
        </mat-card>
      </div>

      <div class="charts">
        <mat-card>
          <h3>Поток и доход по месяцам</h3>
          <p class="note">
            Столбцы на одной оске: поток кэша (депозиты/выводы) и доход (дивиденды/купоны).
          </p>
          <div class="chart-box">
            <canvas
              baseChart
              [type]="timelineChart().type"
              [data]="timelineChart().data"
              [options]="timelineChart().options"
            ></canvas>
          </div>
        </mat-card>

        <mat-card>
          <h3>P&L по системам</h3>
          <div class="chart-box">
            <canvas
              baseChart
              [type]="systemChart().type"
              [data]="systemChart().data"
              [options]="systemChart().options"
            ></canvas>
          </div>
        </mat-card>

        <mat-card class="wide">
          <h3>Прибыль / убыток по инструментам</h3>
          <div class="chart-box tall">
            <canvas
              baseChart
              [type]="breakdownChart().type"
              [data]="breakdownChart().data"
              [options]="breakdownChart().options"
            ></canvas>
          </div>
        </mat-card>
      </div>
    }
  `,
  styles: [
    `
      .totals {
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
        margin-bottom: 16px;
      }
      .totals mat-card {
        padding: 16px;
        min-width: 180px;
        flex: 1;
      }
      .charts {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
      }
      .charts mat-card {
        padding: 16px;
      }
      .charts .wide {
        grid-column: 1 / -1;
      }
      h3 {
        margin: 0 0 8px;
        font-weight: 500;
      }
      .note {
        margin: 0 0 12px;
        font-size: 13px;
        color: rgba(0, 0, 0, 0.6);
      }
      .chart-box {
        position: relative;
        width: 100%;
        height: 320px;
      }
      .chart-box.tall {
        height: 400px;
      }
      .error {
        color: #c62828;
      }
    `,
  ],
})
export class DashboardPage {
  protected readonly api = inject(OperationApi);

  protected readonly totals = computed(
    () =>
      this.api.summary.value()?.totals ?? {
        investedRub: 0,
        currentValueRub: 0,
        pnlRub: 0,
        dividendsRub: 0,
      },
  );

  /** Комбо по месяцам: столбцы Поток (серый) и Доход (зелёный/красный по знаку) */
  protected readonly timelineChart = computed<ChartConfiguration<'bar'>>(() => {
    const t = this.api.summary.value()?.timeline ?? [];
    const incomeColors = t.map((r) => (r.income >= 0 ? C.greenT : C.red));
    return {
      type: 'bar',
      data: {
        labels: t.map((r) => r.period),
        datasets: [
          { label: 'Поток', data: t.map((r) => r.flow), backgroundColor: C.gray, borderRadius: 3 },
          {
            label: 'Доход',
            data: t.map((r) => r.income),
            backgroundColor: incomeColors,
            borderRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${this.money(c.parsed.y)}` } },
        },
        scales: {
          x: { grid: { display: false } },
          y: { ticks: { callback: (v) => '₽' + Math.round(Number(v) / 1000) + 'k' } },
        },
      },
    };
  });

  /** P&L по системам: столбцы, цвет по знаку */
  protected readonly systemChart = computed<ChartConfiguration<'bar'>>(() => {
    const s = this.api.summary.value()?.bySystem ?? [];
    return {
      type: 'bar',
      data: {
        labels: s.map((r) => r.name),
        datasets: [
          {
            label: 'P&L ₽',
            data: s.map((r) => r.pnlRub),
            backgroundColor: s.map((r) => (r.pnlRub >= 0 ? C.green : C.red)),
            borderRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => this.money(c.parsed.y) } },
        },
        scales: { y: { ticks: { callback: (v) => '₽' + Math.round(Number(v) / 1000) + 'k' } } },
      },
    };
  });

  /** Breakdown по инструментам: горизонтальные бары, цвет по знаку */
  protected readonly breakdownChart = computed<ChartConfiguration<'bar'>>(() => {
    const b = this.api.summary.value()?.breakdown ?? [];
    return {
      type: 'bar',
      data: {
        labels: b.map((r) => r.ticker),
        datasets: [
          {
            label: 'P&L ₽',
            data: b.map((r) => r.pnlRub),
            backgroundColor: b.map((r) => (r.pnlRub >= 0 ? C.green : C.red)),
            borderRadius: 3,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => this.money(c.parsed.x) } },
        },
        scales: { x: { ticks: { callback: (v) => '₽' + Math.round(Number(v) / 1000) + 'k' } } },
      },
    };
  });

  protected money(v: number | null): string {
    return formatMoney((v ?? 0).toFixed(2), 'RUB');
  }

  protected cls(v: number): string {
    return pnlColorClass(v);
  }
}
