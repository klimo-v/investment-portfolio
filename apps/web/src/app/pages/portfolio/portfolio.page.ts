import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { BaseChartDirective } from 'ng2-charts';
import type { ChartConfiguration } from 'chart.js';
import type { InstrumentType } from '@core';
import { OperationApi } from '../../entities/operation/operation.api';
import { ReferenceApi } from '../../entities/reference/reference.api';
import {
  TYPE_COLOR,
  TYPE_LABEL,
  TYPE_ORDER,
} from '../../entities/instrument/instrument-type.tokens';
import { ManagePortfoliosDialog } from '../../features/manage-portfolios/manage-portfolios.dialog';
import { ManageSystemsDialog } from '../../features/manage-systems/manage-systems.dialog';
import { formatMoney, KpiCard, type KpiTone, pnlColorClass, StateMessage, ThemeService } from '@web-shared';

/**
 * Страница «Портфель» (docs/03-ux-plan.md, шаг 3; roadmap Фаза 2).
 * Позиции из API (движок @core на бэке), текущие цены — из котировок (MOEX/ЦБ).
 * Группировка по типам инструментов, фильтр по системе/портфелю, круговая
 * диаграмма распределения текущей стоимости.
 */

interface Row {
  ticker: string;
  qty: string;
  avg: string;
  current: string;
  value: string;
  pnl: string;
  pnlClass: string;
}
interface Group {
  type: InstrumentType;
  label: string;
  rows: Row[];
  valueRub: number;
}

@Component({
  selector: 'app-portfolio-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatCardModule,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatSelectModule,
    MatTooltipModule,
    BaseChartDirective,
    KpiCard,
    StateMessage,
  ],
  template: `
    <div class="header">
      <h1 class="page-title">Портфель</h1>
      <div class="actions">
        <button mat-stroked-button (click)="managePortfolios()">
          <mat-icon>account_balance</mat-icon>
          Портфели
        </button>
        <button mat-stroked-button (click)="manageSystems()">
          <mat-icon>category</mat-icon>
          Системы
        </button>
        <button mat-stroked-button (click)="refresh()" [disabled]="refreshing()">
          <mat-icon>refresh</mat-icon>
          {{ refreshing() ? 'Обновление…' : 'Обновить цены' }}
        </button>
      </div>
    </div>

    <div class="filters">
      <mat-form-field appearance="outline">
        <mat-label>Система</mat-label>
        <mat-select [value]="systemFilter()" (valueChange)="systemFilter.set($event)">
          <mat-option [value]="null">Все системы</mat-option>
          @for (s of systemOptions(); track s.id) {
            <mat-option [value]="s.id">{{ s.name }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Портфель</mat-label>
        <mat-select [value]="portfolioFilter()" (valueChange)="portfolioFilter.set($event)">
          <mat-option [value]="null">Все портфели</mat-option>
          @for (p of portfolioOptions(); track p.id) {
            <mat-option [value]="p.id">{{ p.name }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
    </div>

    <div class="kpi-grid">
      <app-kpi-card label="Вложено (₽)" [value]="investedTotal()" />
      <app-kpi-card label="Текущая стоимость (₽)" [value]="valueTotal()" />
      <app-kpi-card
        label="Получено дивидендов/купонов (₽)"
        [value]="dividendsTotal()"
        [hint]="dividendsHint"
      />
      <app-kpi-card
        label="P&L (₽)"
        [value]="pnlTotal()"
        [tone]="pnlTone()"
        [hint]="pnlHint"
      />
    </div>

    @if (api.positions.error()) {
      <app-state-message
        kind="error"
        title="Не удалось загрузить позиции"
        hint="Проверьте, что сервер запущен, и попробуйте ещё раз."
        retryLabel="Повторить"
        (retry)="api.reload()"
      />
    } @else if (!api.positions.isLoading() && groups().length === 0) {
      <mat-card>
        @if (positions().length === 0) {
          <app-state-message
            kind="empty"
            title="Позиций пока нет"
            hint="Добавьте операции на странице «Операции» или загрузите отчёт брокера на странице «Импорт»."
          />
        } @else {
          <app-state-message
            kind="empty"
            icon="filter_alt_off"
            title="Нет позиций под выбранные фильтры"
            hint="Сбросьте фильтр системы или портфеля, чтобы увидеть остальные позиции."
          />
        }
      </mat-card>
    } @else if (!api.positions.isLoading()) {
      <div class="content">
        <div class="tables">
          @for (g of groups(); track g.type) {
            <mat-card class="group">
              <div class="group-head">
                <h3>{{ g.label }}</h3>
                <span class="group-total">{{ money(g.valueRub) }}</span>
              </div>
              <table mat-table [dataSource]="g.rows">
                <ng-container matColumnDef="ticker">
                  <th mat-header-cell *matHeaderCellDef>Тикер</th>
                  <td mat-cell *matCellDef="let r">{{ r.ticker }}</td>
                </ng-container>
                <ng-container matColumnDef="qty">
                  <th mat-header-cell *matHeaderCellDef>Кол-во</th>
                  <td mat-cell *matCellDef="let r">{{ r.qty }}</td>
                </ng-container>
                <ng-container matColumnDef="avg">
                  <th mat-header-cell *matHeaderCellDef>Средняя</th>
                  <td mat-cell *matCellDef="let r">{{ r.avg }}</td>
                </ng-container>
                <ng-container matColumnDef="current">
                  <th mat-header-cell *matHeaderCellDef>Тек. цена</th>
                  <td mat-cell *matCellDef="let r">{{ r.current }}</td>
                </ng-container>
                <ng-container matColumnDef="value">
                  <th mat-header-cell *matHeaderCellDef>Стоимость (₽)</th>
                  <td mat-cell *matCellDef="let r">{{ r.value }}</td>
                </ng-container>
                <ng-container matColumnDef="pnl">
                  <th mat-header-cell *matHeaderCellDef>P&L (₽)</th>
                  <td mat-cell *matCellDef="let r" [class]="r.pnlClass">{{ r.pnl }}</td>
                </ng-container>
                <tr mat-header-row *matHeaderRowDef="columns"></tr>
                <tr mat-row *matRowDef="let row; columns: columns"></tr>
              </table>
            </mat-card>
          }
        </div>

        <mat-card class="pie">
          <h3>Распределение по типам</h3>
          @if (pieHasData()) {
            <div class="chart-box">
              <canvas
                baseChart
                [type]="pieChart().type"
                [data]="pieChart().data"
                [options]="pieChart().options"
              ></canvas>
            </div>
          } @else {
            <p class="empty">Нет текущих цен — обновите котировки, чтобы увидеть распределение.</p>
          }
        </mat-card>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }
      .header {
        flex: 0 0 auto;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .actions {
        display: flex;
        gap: 8px;
      }
      /* .filters — глобальный (styles.scss) */
      .filters {
        flex: 0 0 auto;
        margin: 8px 0 0;
      }
      /* .kpi-grid — глобальный (styles.scss); здесь только «не растягиваться» */
      .kpi-grid {
        flex: 0 0 auto;
      }
      /*
       * Mobile-first: на узком экране таблицы и диаграмма идут друг под другом.
       * Единственный настоящий медиазапрос во всём приложении — соотношение 2fr/1fr
       * надо СОХРАНИТЬ на широких экранах, а auto-fit этого выразить не может.
       */
      .content {
        display: grid;
        grid-template-columns: 1fr;
        gap: 16px;
        align-items: start;
        flex: 1;
        min-height: 0;
        overflow: auto;
      }
      @media (min-width: 960px) {
        .content {
          grid-template-columns: 2fr 1fr;
        }
      }
      .tables {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .group {
        padding: 8px 8px 0;
      }
      .group-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        padding: 8px 8px 0;
      }
      .group-head h3 {
        margin: 0;
        font-weight: 500;
      }
      .group-total {
        color: var(--app-text-muted);
      }
      .hint-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        /* --app-text-muted, а не --app-outline: outline-variant в M3 намеренно
           малоконтрастен (для разделителей), и бейдж «?» на нём почти пропадает */
        border: 1px solid var(--app-text-muted);
        color: var(--app-text-muted);
        font-size: 10px;
        cursor: help;
      }
      .pie {
        padding: 16px;
      }
      .pie h3 {
        margin: 0 0 8px;
        font-weight: 500;
      }
      table {
        width: 100%;
      }
      /* .chart-box и .error — глобальные (styles.scss) */
      .empty {
        padding: 24px;
        text-align: center;
        color: var(--app-text-muted);
      }
    `,
  ],
})
export class PortfolioPage {
  protected readonly api = inject(OperationApi);
  private readonly reference = inject(ReferenceApi);
  private readonly dialog = inject(MatDialog);
  private readonly theme = inject(ThemeService);

  protected readonly columns = ['ticker', 'qty', 'avg', 'current', 'value', 'pnl'];
  protected readonly refreshing = signal(false);

  /**
   * Дивиденды/купоны — это уже полученный кэш, не переоценка позиции, поэтому
   * не входят в «Текущую стоимость» (она — рыночная цена держимых бумаг), но
   * входят в P&L. Без этой карточки разница между «Вложено/Текущая» и P&L
   * выглядит как «пропавшие деньги» — реальный вопрос пользователя.
   */
  protected readonly dividendsHint =
    'Дивиденды и купоны, уже выплаченные вам, — это кэш, не переоценка бумаги. ' +
    'Они не входят в «Текущую стоимость» (там только рыночная цена держимых позиций), ' +
    'но входят в P&L. Поэтому P&L может быть положительным, даже если рынок просел.';

  /**
   * P&L = реализ. + нереализ. + дивиденды — включает результат по уже закрытым
   * (проданным) позициям, а не только по текущему остатку. «Вложено − Стоимость −
   * Дивиденды» даст другое число — оно молча теряет уже зафиксированную прибыль/убыток.
   */
  protected readonly pnlHint =
    'P&L = реализ. + нереализ. + дивиденды/купоны. Реализ. — результат по уже ' +
    'закрытым (проданным) позициям, эти деньги уже ваши независимо от того, ' +
    'вывели вы их или реинвестировали. «Вложено − Стоимость − Дивиденды» даст ' +
    'другое число — оно молча теряет эту уже зафиксированную прибыль/убыток.';

  protected readonly systemFilter = signal<string | null>(null);
  protected readonly portfolioFilter = signal<string | null>(null);

  constructor() {
    // Прокидываем фильтр в OperationApi — итоговые карточки берут те же
    // отфильтрованные totals(), что и таблица «Эффективность» на дашборде.
    effect(() => {
      this.api.summaryFilter.set({
        systemId: this.systemFilter() ?? undefined,
        portfolioId: this.portfolioFilter() ?? undefined,
      });
    });
  }

  /** Все позиции из API */
  private readonly allPositions = computed(() => this.api.positions.value() ?? []);

  /** Позиции после применения фильтров по системе/портфелю */
  protected readonly positions = computed(() => {
    const sys = this.systemFilter();
    const port = this.portfolioFilter();
    return this.allPositions().filter(
      (p) => (sys === null || p.systemId === sys) && (port === null || p.portfolioId === port),
    );
  });

  /** Опции фильтров — только системы/портфели, которые реально встречаются в позициях */
  protected readonly systemOptions = computed(() => {
    const names = new Map((this.reference.systems.value() ?? []).map((s) => [s.id, s.name]));
    const ids = [...new Set(this.allPositions().map((p) => p.systemId))];
    return ids.map((id) => ({ id, name: names.get(id) ?? id }));
  });

  protected readonly portfolioOptions = computed(() => {
    const names = new Map((this.reference.portfolios.value() ?? []).map((p) => [p.id, p.name]));
    const ids = [...new Set(this.allPositions().map((p) => p.portfolioId))];
    return ids.map((id) => ({ id, name: names.get(id) ?? id }));
  });

  /** Позиции, сгруппированные по типу инструмента (с подытогом стоимости) */
  protected readonly groups = computed<Group[]>(() => {
    const byType = new Map<InstrumentType, Row[]>();
    const valueByType = new Map<InstrumentType, number>();

    for (const p of this.positions()) {
      const rows = byType.get(p.type) ?? [];
      rows.push({
        ticker: p.ticker,
        qty: p.quantity,
        avg: formatMoney(p.avgBuyPrice, p.currency),
        current: p.currentPrice ? formatMoney(p.currentPrice, p.currency) : '—',
        value: p.currentValueRub ? formatMoney(p.currentValueRub, 'RUB') : '—',
        pnl: p.pnlRub ? formatMoney(p.pnlRub, 'RUB') : '—',
        pnlClass: p.pnlRub ? pnlColorClass(p.pnlRub) : 'pnl-zero',
      });
      byType.set(p.type, rows);
      valueByType.set(p.type, (valueByType.get(p.type) ?? 0) + Number(p.currentValueRub ?? 0));
    }

    return TYPE_ORDER.filter((t) => byType.has(t)).map((t) => ({
      type: t,
      label: TYPE_LABEL[t],
      rows: byType.get(t)!,
      valueRub: valueByType.get(t) ?? 0,
    }));
  });

  protected readonly pieHasData = computed(() => this.groups().some((g) => g.valueRub > 0));

  /** Круговая диаграмма: доля текущей стоимости (₽) по типам инструментов */
  protected readonly pieChart = computed<ChartConfiguration<'doughnut'>>(() => {
    const data = this.groups().filter((g) => g.valueRub > 0);
    // Зависимость от темы обязательна: Chart.defaults (цвет легенды) — JS-значения,
    // уже отрисованный график сам их не перечитает, конфиг должен пересобраться
    const dark = this.theme.isDark();
    return {
      type: 'doughnut',
      data: {
        labels: data.map((g) => g.label),
        datasets: [
          {
            data: data.map((g) => g.valueRub),
            backgroundColor: data.map((g) => TYPE_COLOR[g.type]),
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
          tooltip: { callbacks: { label: (c) => `${c.label}: ${this.money(Number(c.parsed))}` } },
        },
      },
    };
  });

  /**
   * Итоговые карточки берём из summary().totals (та же формула и тот же фильтр,
   * что у таблицы «Эффективность» на дашборде: P&L = реализ. + нереализ. +
   * дивиденды), а НЕ суммируем построчный pnl текущих позиций — тот считает
   * только открытый остаток и не видит результат по уже закрытым сделкам.
   * Раньше это расходилось с дашбордом ровно на величину реализованного P&L
   * (напр. −84 248,81 ₽ здесь против −45 915,13 ₽ на дашборде для тех же данных).
   */
  private readonly totals = computed(() => this.api.summary.value()?.totals);

  protected readonly investedTotal = computed(() =>
    formatMoney((this.totals()?.investedRub ?? 0).toFixed(2), 'RUB'),
  );

  protected readonly valueTotal = computed(() =>
    formatMoney((this.totals()?.currentValueRub ?? 0).toFixed(2), 'RUB'),
  );

  protected readonly pnlTotalRaw = computed(() => this.totals()?.pnlRub ?? 0);

  protected readonly pnlTotal = computed(() => formatMoney(this.pnlTotalRaw().toFixed(2), 'RUB'));

  protected readonly pnlTone = computed<KpiTone>(() => {
    const v = this.pnlTotalRaw();
    if (v === 0) return 'neutral';
    return v > 0 ? 'positive' : 'negative';
  });

  protected readonly dividendsTotal = computed(() =>
    formatMoney((this.totals()?.dividendsRub ?? 0).toFixed(2), 'RUB'),
  );

  protected pnlClass(value: number): string {
    return pnlColorClass(value);
  }

  protected money(v: number): string {
    return formatMoney(v.toFixed(2), 'RUB');
  }

  protected managePortfolios(): void {
    this.dialog.open(ManagePortfoliosDialog, { autoFocus: false, width: '760px', maxWidth: '95vw' });
  }

  protected manageSystems(): void {
    this.dialog.open(ManageSystemsDialog, { autoFocus: false, width: '760px', maxWidth: '95vw' });
  }

  protected async refresh(): Promise<void> {
    this.refreshing.set(true);
    try {
      await this.api.refreshQuotes();
    } finally {
      this.refreshing.set(false);
    }
  }
}
