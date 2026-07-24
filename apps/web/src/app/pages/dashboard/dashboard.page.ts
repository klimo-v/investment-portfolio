import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { BaseChartDirective } from 'ng2-charts';
import type { ChartConfiguration } from 'chart.js';
import { maxDrawdown, type Effectiveness } from '@core';
import { OperationApi } from '../../entities/operation/operation.api';
import { SnapshotApi } from '../../entities/snapshot/snapshot.api';
import { BenchmarkApi } from '../../entities/benchmark/benchmark.api';
import { formatMoney, formatPercent, pnlColorClass } from '@web-shared';

/**
 * Дашборд (docs/03-ux-plan.md шаг 4; docs/05-review-usability.md §1).
 * Кроме комбо-графиков строит метрики ЭФФЕКТИВНОСТИ: доходность в % и годовых
 * (XIRR), реализ./нереализ. P&L, дивидендная доходность — по портфелю и в разрезе
 * систем/портфелей, чтобы их можно было сравнивать (абсолютный P&L сравнивать
 * нельзя). Плюс max drawdown из снимков и линия «Портфель vs IMOEX/Депозит».
 */

/** Палитра из portfolio_dashboard.html */
const C = {
  blue: '#2a78d6',
  gray: '#888780',
  green: '#199e70',
  greenT: '#1baf7a',
  red: '#e34948',
  violet: '#8e5bd8',
  amber: '#e0a400',
};

/**
 * Годовая ставка вклада-ориентира для линии «Депозит» (что было бы, положи те же
 * деньги на вклад). Допущение — при желании выносится в настройки; ориентир —
 * ключевая ставка периода.
 */
const DEPOSIT_ANNUAL_RATE = 0.16;

interface EffRow extends Effectiveness {
  id: string;
  name: string;
}

@Component({
  selector: 'app-dashboard-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatTableModule, MatButtonToggleModule, MatTooltipModule, BaseChartDirective],
  template: `
    <h1 class="page-title">Дашборд</h1>

    @if (api.summary.isLoading()) {
      <p>Загрузка…</p>
    } @else if (api.summary.error()) {
      <p class="error">Не удалось загрузить сводку. Запущен ли API?</p>
    } @else {
      <div class="totals">
        <mat-card>
          <mat-card-subtitle
            >Вложено <span class="hint" matTooltip="Себестоимость держимого остатка — сходится с колонкой «Вложено» на странице «Сделки»">?</span></mat-card-subtitle
          >
          <mat-card-title>{{ money(totals().investedRub) }}</mat-card-title>
        </mat-card>
        <mat-card>
          <mat-card-subtitle>Текущая стоимость</mat-card-subtitle>
          <mat-card-title>{{ money(totals().currentValueRub) }}</mat-card-title>
        </mat-card>
        <mat-card>
          <mat-card-subtitle>P&L</mat-card-subtitle>
          <mat-card-title [class]="cls(totals().pnlRub)">{{ money(totals().pnlRub) }}</mat-card-title>
          <div class="sub">
            реализ. <span [class]="cls(totals().realizedPnlRub)">{{ money(totals().realizedPnlRub) }}</span>
            · нереализ. <span [class]="cls(totals().unrealizedPnlRub)">{{ money(totals().unrealizedPnlRub) }}</span>
          </div>
        </mat-card>
        <mat-card>
          <mat-card-subtitle
            >ROI <span class="hint" matTooltip="P&L относительно вложенного (себестоимости держимого остатка)">?</span></mat-card-subtitle
          >
          <mat-card-title [class]="cls(totals().roiPct ?? 0)">{{ pctOrDash(totals().roiPct) }}</mat-card-title>
        </mat-card>
        <mat-card>
          <mat-card-subtitle
            >Доходность годовых (XIRR)
            <span class="hint" matTooltip="Денежно-взвешенная годовая доходность с учётом дат вложений">?</span></mat-card-subtitle
          >
          <mat-card-title [class]="cls(totals().xirrPct ?? 0)">{{ pctOrDash(totals().xirrPct) }}</mat-card-title>
        </mat-card>
        <mat-card>
          <mat-card-subtitle>Дивиденды + купоны</mat-card-subtitle>
          <mat-card-title>{{ money(totals().dividendsRub) }}</mat-card-title>
          <div class="sub">доходность {{ pctOrDash(totals().dividendYieldPct) }}</div>
        </mat-card>
        <mat-card>
          <mat-card-subtitle
            >Макс. просадка
            <span class="hint" matTooltip="Наибольшее падение стоимости портфеля от пика к дну по снимкам">?</span></mat-card-subtitle
          >
          <mat-card-title [class]="cls(maxDrawdownPct())">
            {{ hasDrawdown() ? pctOrDash(maxDrawdownPct()) : '—' }}
          </mat-card-title>
        </mat-card>
      </div>

      <mat-card class="eff">
        <div class="eff-head">
          <h3>Эффективность</h3>
          <mat-button-toggle-group [value]="groupBy()" (change)="groupBy.set($event.value)" hideSingleSelectionIndicator>
            <mat-button-toggle value="system">По системам</mat-button-toggle>
            <mat-button-toggle value="portfolio">По портфелям</mat-button-toggle>
          </mat-button-toggle-group>
        </div>
        @if (effRows().length === 0) {
          <p class="note">Нет данных — добавьте операции и обновите цены.</p>
        } @else {
          <table mat-table [dataSource]="effRows()">
            <ng-container matColumnDef="name">
              <th mat-header-cell *matHeaderCellDef>Название</th>
              <td mat-cell *matCellDef="let r">{{ r.name }}</td>
            </ng-container>
            <ng-container matColumnDef="invested">
              <th mat-header-cell *matHeaderCellDef>Вложено</th>
              <td mat-cell *matCellDef="let r">{{ money(r.investedRub) }}</td>
            </ng-container>
            <ng-container matColumnDef="value">
              <th mat-header-cell *matHeaderCellDef>Стоимость</th>
              <td mat-cell *matCellDef="let r">{{ money(r.currentValueRub) }}</td>
            </ng-container>
            <ng-container matColumnDef="realized">
              <th mat-header-cell *matHeaderCellDef>Реализ. / Нереализ.</th>
              <td mat-cell *matCellDef="let r">
                <span [class]="cls(r.realizedPnlRub)">{{ money(r.realizedPnlRub) }}</span>
                /
                <span [class]="cls(r.unrealizedPnlRub)">{{ money(r.unrealizedPnlRub) }}</span>
              </td>
            </ng-container>
            <ng-container matColumnDef="pnl">
              <th mat-header-cell *matHeaderCellDef>P&L</th>
              <td mat-cell *matCellDef="let r" [class]="cls(r.pnlRub)">{{ money(r.pnlRub) }}</td>
            </ng-container>
            <ng-container matColumnDef="roi">
              <th mat-header-cell *matHeaderCellDef>ROI</th>
              <td mat-cell *matCellDef="let r" [class]="cls(r.roiPct ?? 0)">{{ pctOrDash(r.roiPct) }}</td>
            </ng-container>
            <ng-container matColumnDef="xirr">
              <th mat-header-cell *matHeaderCellDef>XIRR</th>
              <td mat-cell *matCellDef="let r" [class]="cls(r.xirrPct ?? 0)">{{ pctOrDash(r.xirrPct) }}</td>
            </ng-container>
            <ng-container matColumnDef="divyield">
              <th mat-header-cell *matHeaderCellDef>Див. дох.</th>
              <td mat-cell *matCellDef="let r">{{ pctOrDash(r.dividendYieldPct) }}</td>
            </ng-container>
            <tr mat-header-row *matHeaderRowDef="effColumns"></tr>
            <tr mat-row *matRowDef="let row; columns: effColumns"></tr>
          </table>
        }
      </mat-card>

      <div class="charts">
        <mat-card class="wide">
          <h3>Портфель против рынка</h3>
          <p class="note">
            Рост ₽100, вложенных в начале периода: ваш портфель, индекс МосБиржи (IMOEX)
            и вклад под {{ depositRatePct }}% годовых. По снимкам стоимости.
          </p>
          @if (benchmarkChart(); as bc) {
            <div class="chart-box">
              <canvas baseChart [type]="bc.type" [data]="bc.data" [options]="bc.options"></canvas>
            </div>
          } @else {
            <p class="note">
              Нужно минимум два снимка стоимости и данные индекса. Снимки появляются на
              странице «Портфель» при нажатии «Обновить цены».
            </p>
          }
        </mat-card>

        <mat-card class="wide">
          <h3>Стоимость портфеля во времени</h3>
          @if (snapshots.list.value()?.length) {
            <div class="chart-box">
              <canvas
                baseChart
                [type]="valueChart().type"
                [data]="valueChart().data"
                [options]="valueChart().options"
              ></canvas>
            </div>
          } @else {
            <p class="note">
              Снимков пока нет — они появляются на странице «Портфель» при нажатии
              «Обновить цены» (по одному снимку в день).
            </p>
          }
        </mat-card>

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
        min-width: 170px;
        flex: 1;
      }
      .sub {
        margin-top: 4px;
        font-size: 12px;
        color: rgba(0, 0, 0, 0.6);
      }
      .hint {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 1px solid rgba(0, 0, 0, 0.4);
        color: rgba(0, 0, 0, 0.6);
        font-size: 10px;
        cursor: help;
      }
      .eff {
        padding: 16px;
        margin-bottom: 16px;
        overflow-x: auto;
      }
      .eff-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      .eff-head h3 {
        margin: 0;
        font-weight: 500;
      }
      .eff table {
        width: 100%;
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
      .pnl-positive {
        color: #2e7d32;
      }
      .pnl-negative {
        color: #c62828;
      }
      .error {
        color: #c62828;
      }
    `,
  ],
})
export class DashboardPage {
  protected readonly api = inject(OperationApi);
  protected readonly snapshots = inject(SnapshotApi);
  protected readonly benchmark = inject(BenchmarkApi);

  protected readonly depositRatePct = (DEPOSIT_ANNUAL_RATE * 100).toFixed(0);
  protected readonly groupBy = signal<'system' | 'portfolio'>('system');
  protected readonly effColumns = [
    'name',
    'invested',
    'value',
    'realized',
    'pnl',
    'roi',
    'xirr',
    'divyield',
  ];

  private static readonly EMPTY: Effectiveness = {
    investedRub: 0,
    currentValueRub: 0,
    realizedPnlRub: 0,
    unrealizedPnlRub: 0,
    dividendsRub: 0,
    pnlRub: 0,
    roiPct: null,
    dividendYieldPct: null,
    xirrPct: null,
  };

  protected readonly totals = computed<Effectiveness>(
    () => this.api.summary.value()?.totals ?? DashboardPage.EMPTY,
  );

  /** Строки таблицы эффективности — по системам или по портфелям */
  protected readonly effRows = computed<EffRow[]>(() => {
    const s = this.api.summary.value();
    if (!s) return [];
    return this.groupBy() === 'system'
      ? s.bySystem.map((r) => ({ ...r, id: r.systemId }))
      : s.byPortfolio.map((r) => ({ ...r, id: r.portfolioId }));
  });

  /** Снимки по возрастанию даты (для просадки и графика динамики) */
  private readonly snaps = computed(() =>
    [...(this.snapshots.list.value() ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
  );

  protected readonly hasDrawdown = computed(() => this.snaps().length >= 2);
  /** Макс. просадка стоимости портфеля по снимкам (доля ≤ 0 → в %) */
  protected readonly maxDrawdownPct = computed(
    () => maxDrawdown(this.snaps().map((s) => s.currentValueRub)) * 100,
  );

  constructor() {
    // Диапазон запроса истории индекса — от первого снимка до сегодня
    effect(() => {
      const s = this.snaps();
      if (s.length < 2) {
        this.benchmark.range.set(null);
        return;
      }
      this.benchmark.range.set({ from: s[0].date, till: new Date().toISOString().slice(0, 10) });
    });
  }

  /** Линия динамики: Вложено (серый) vs Текущая стоимость (синий) по датам снимков */
  protected readonly valueChart = computed<ChartConfiguration<'line'>>(() => {
    const s = this.snaps();
    return {
      type: 'line',
      data: {
        labels: s.map((r) => r.date),
        datasets: [
          {
            label: 'Вложено',
            data: s.map((r) => r.investedRub),
            borderColor: C.gray,
            backgroundColor: C.gray,
            pointRadius: 2,
            tension: 0.2,
          },
          {
            label: 'Текущая стоимость',
            data: s.map((r) => r.currentValueRub),
            borderColor: C.blue,
            backgroundColor: C.blue,
            pointRadius: 2,
            tension: 0.2,
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

  /**
   * Линия «Портфель vs рынок»: рост ₽100 от начала периода. Портфель — по снимкам
   * стоимости, IMOEX — по истории индекса (выравнивается на дату снимка: берём
   * последнее закрытие на дату или раньше), Депозит — фиксированная ставка.
   * null — если данных для сравнения недостаточно.
   */
  protected readonly benchmarkChart = computed<ChartConfiguration<'line'> | null>(() => {
    const s = this.snaps();
    const b = [...(this.benchmark.history.value() ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    if (s.length < 2 || b.length === 0) return null;

    const baseValue = s[0].currentValueRub > 0 ? s[0].currentValueRub : s[0].investedRub;
    if (baseValue <= 0) return null;

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
          { label: 'Портфель', data: portfolio, borderColor: C.blue, backgroundColor: C.blue, pointRadius: 2, tension: 0.2 },
          { label: 'IMOEX', data: imoex, borderColor: C.amber, backgroundColor: C.amber, pointRadius: 2, tension: 0.2 },
          { label: 'Депозит', data: deposit, borderColor: C.gray, backgroundColor: C.gray, pointRadius: 0, borderDash: [6, 4], tension: 0 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${Number(c.parsed.y).toFixed(1)}` } },
        },
        scales: {
          x: { grid: { display: false } },
          y: { ticks: { callback: (v) => Number(v).toFixed(0) } },
        },
      },
    };
  });

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

  /** Процент или «—», если метрика не определена (например, вложено = 0) */
  protected pctOrDash(v: number | null): string {
    return v === null ? '—' : formatPercent(v);
  }

  protected cls(v: number): string {
    return pnlColorClass(v);
  }
}
