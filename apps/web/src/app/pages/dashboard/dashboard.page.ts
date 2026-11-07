import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { maxDrawdown, type Cash, type Effectiveness } from '@core';
import { ConfirmService, StateMessage } from '@web-shared';
import { summaryResource, type SummaryFilter } from '../../entities/summary/summary.api';
import { SnapshotApi, type SnapshotStaleness } from '../../entities/snapshot/snapshot.api';
import { benchmarkResource, type BenchmarkRange } from '../../entities/benchmark/benchmark.api';
import { PositionSeriesApi } from '../../entities/position-series/position-series.api';
import { DataRevision } from '../../shared/data-revision';
import { DashboardFilters } from '../../widgets/dashboard-filters/dashboard-filters';
import { dashboardFilter } from '../../widgets/dashboard-filters/dashboard-filter.state';
import { SummaryKpis } from '../../widgets/summary-kpis/summary-kpis';
import {
  EffectivenessTable,
  type EffGroupBy,
  type EffRow,
} from '../../widgets/effectiveness-table/effectiveness-table';
import { BenchmarkChart } from '../../widgets/benchmark-chart/benchmark-chart';
import { PositionsSeriesChart } from '../../widgets/positions-series-chart/positions-series-chart';
import { CashflowChart } from '../../widgets/cashflow-chart/cashflow-chart';
import { PnlBarChart } from '../../widgets/pnl-bar-chart/pnl-bar-chart';
import {
  SnapshotChangesDialog,
  type SnapshotChangesResult,
} from '../../features/snapshot-changes/snapshot-changes.dialog';

/**
 * Дашборд (docs/03-ux-plan.md шаг 4; docs/05-review-usability.md §1).
 *
 * Страница отвечает ровно за три вещи: собрать данные под текущий фильтр, разложить
 * виджеты по сетке и решить, что грузится сразу, а что при прокрутке. Вся разметка
 * и все расчёты показателей живут в виджетах (FSD, CLAUDE.md §2) — раньше это был
 * один компонент на 950 строк с шестью конфигурациями Chart.js внутри.
 *
 * @defer вокруг графиков не только откладывает создание Chart-инстансов: ng2-charts
 * и chart.js импортирует ТОЛЬКО app-chart-canvas, поэтому вся библиотека уезжает в
 * отложенный чанк и не загружается, пока до графика не долистали.
 */
@Component({
  selector: 'app-dashboard-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    StateMessage,
    DashboardFilters,
    SummaryKpis,
    EffectivenessTable,
    BenchmarkChart,
    PositionsSeriesChart,
    CashflowChart,
    PnlBarChart,
  ],
  template: `
    <div class="page-header">
      <h1 class="page-title">
        Дашборд
        @if (filter.label(); as label) {
          <span class="period-range">({{ label }})</span>
        }
      </h1>
      <app-dashboard-filters />
    </div>

    @if (summary.error()) {
      <app-state-message
        kind="error"
        title="Не удалось загрузить сводку"
        hint="Проверьте, что сервер запущен, и попробуйте ещё раз."
        retryLabel="Повторить"
        (retry)="reload()"
      />
      <!--
        hasValue(), а НЕ !isLoading(): isLoading() истинно и при ПЕРЕЗАГРУЗКЕ, поэтому
        каждая смена системы/портфеля/периода уничтожала всё тело дашборда вместе с
        шестью <canvas> и строила заново — Chart.js получал destroy + новый инстанс,
        а пользователь видел мигание. Теперь при перезапросе на экране остаются
        прежние цифры (о том, что идёт загрузка, сообщает mat-progress-bar в тулбаре),
        а скрыто всё только пока данных нет вообще — на первой загрузке.
      -->
    } @else if (summary.hasValue()) {
      <app-summary-kpis
        [totals]="totals()"
        [cash]="cash()"
        [drawdownPct]="maxDrawdownPct()"
        [pnlHint]="pnlHint"
      />

      <app-effectiveness-table
        [rows]="effRows()"
        [groupBy]="groupBy()"
        (groupByChange)="groupBy.set($event)"
        [pnlHint]="pnlHint"
        [portfolioId]="filter.portfolio()"
      />

      <div class="charts">
        <!--
          Плейсхолдеры повторяют геометрию .chart-box, поэтому подгрузка виджета не
          дёргает вёрстку.
        -->
        <div class="wide">
          @defer (on viewport) {
            <app-benchmark-chart
              [snapshots]="snaps()"
              [points]="benchmark.value() ?? []"
              [segmented]="filter.segmented()"
            />
          } @placeholder {
            <div class="chart-box"></div>
          }
        </div>

        <div class="wide">
          @defer (on viewport) {
            <app-positions-series-chart
              [series]="positionSeries.series.value()"
              [segmented]="filter.segmented()"
              [staleness]="snapshots.staleness.value() ?? null"
              [capturing]="capturing()"
              (capture)="capture()"
              (showChanges)="openChanges()"
            />
          } @placeholder {
            <div class="chart-box tall"></div>
          }
        </div>

        @defer (on viewport) {
          <!-- Внутри hasValue() компилятор уже знает, что value() определено -->
          <app-cashflow-chart [timeline]="summary.value().timeline" />
        } @placeholder {
          <div class="chart-box"></div>
        }

        @defer (on viewport) {
          <app-pnl-bar-chart
            title="P&L по системам"
            [bars]="systemBars()"
            emptyTitle="Нет данных по системам"
            emptyHint="Добавьте операции — P&L разложится по торговым системам."
          />
        } @placeholder {
          <div class="chart-box"></div>
        }

        <div class="wide">
          @defer (on viewport) {
            <app-pnl-bar-chart
              title="Прибыль / убыток по инструментам"
              [bars]="instrumentBars()"
              [horizontal]="true"
              emptyTitle="Нет данных по инструментам"
              emptyHint="Обновите цены на странице «Портфель», чтобы увидеть прибыль и убыток по тикерам."
            />
          } @placeholder {
            <div class="chart-box tall"></div>
          }
        </div>
      </div>
    }
  `,
  styles: [
    `
      .period-range {
        font-size: 14px;
        font-weight: 400;
        color: var(--app-text-muted);
        white-space: nowrap;
        margin-left: 8px;
      }
      /*
       * auto-fit + minmax вместо жёстких двух колонок: на узком экране график
       * шириной в пол-контейнера превращался в нечитаемую полоску, а медиазапрос по
       * вьюпорту не учёл бы, что сайднав тоже съедает ширину.
       */
      .charts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
        gap: 16px;
      }
      .charts .wide {
        grid-column: 1 / -1;
      }
      /* .chart-box, .filters, .kpi-grid — глобальные (styles.scss) */
    `,
  ],
})
export class DashboardPage {
  private readonly revision = inject(DataRevision);
  private readonly dialog = inject(MatDialog);
  private readonly confirm = inject(ConfirmService);
  protected readonly snapshots = inject(SnapshotApi);
  protected readonly positionSeries = inject(PositionSeriesApi);

  /** Снимок сохраняется прямо сейчас — кнопка в виджете блокируется */
  protected readonly capturing = signal(false);

  /** Фильтр читается из адресной строки — тем же способом, что и в виджете фильтров */
  protected readonly filter = dashboardFilter();

  protected readonly groupBy = signal<EffGroupBy>('system');

  /**
   * P&L = реализ. + нереализ. + дивиденды. Реализ./дивиденды — за выбранный период
   * (продажи/выплаты внутри окна), нереализ. — состояние остатка сейчас. Частый
   * вопрос: «Вложено − Стоимость − Дивиденды» даёт другое число, потому что
   * молча выбрасывает уже зафиксированную реализованную прибыль/убыток.
   */
  protected readonly pnlHint =
    'P&L = реализ. + нереализ. + дивиденды/купоны за выбранный период. Реализ./' +
    'дивиденды — от продаж/выплат ВНУТРИ периода, эти деньги уже ваши независимо ' +
    'от того, вывели вы их или реинвестировали. Нереализ. — переоценка текущего ' +
    'остатка, от периода не зависит. «Вложено − Стоимость − Дивиденды» даст другое ' +
    'число — оно молча теряет уже зафиксированную реализованную прибыль/убыток.';

  private readonly summaryFilter = computed<SummaryFilter>(() => {
    const r = this.filter.range();
    return {
      systemId: this.filter.system() ?? undefined,
      portfolioId: this.filter.portfolio() ?? undefined,
      from: r.from,
      till: r.till,
    };
  });

  /** Агрегаты дашборда под фильтр ЭТОЙ страницы (см. entities/summary) */
  protected readonly summary = summaryResource(this.summaryFilter);

  /** Перезапросить всё после ошибки — кнопка «Повторить» */
  protected reload(): void {
    this.revision.bump();
  }

  /**
   * Зафиксировать текущую стоимость инструментов — кнопка «Сделать снимок».
   * Раньше снимок был побочным эффектом «Обновить цены» на другой странице; теперь
   * момент фиксации выбирает пользователь, там же, где смотрит на график.
   */
  protected async capture(): Promise<void> {
    this.capturing.set(true);
    try {
      await this.snapshots.capture();
    } finally {
      this.capturing.set(false);
    }
  }

  /**
   * Модалка «что изменилось после снимков». Очистка истории необратима, поэтому
   * идёт через подтверждение (ConfirmService) — раньше ровно это делалось молча
   * при каждой правке журнала задним числом.
   */
  protected async openChanges(): Promise<void> {
    const staleness = this.snapshots.staleness.value();
    if (!staleness) return;

    const ref = this.dialog.open<SnapshotChangesDialog, SnapshotStaleness, SnapshotChangesResult>(
      SnapshotChangesDialog,
      { data: staleness, autoFocus: false, maxWidth: '95vw' },
    );
    const result = await firstValueFrom(ref.afterClosed());
    if (!result) return;

    if (result === 'acknowledge') {
      await this.snapshots.acknowledge();
      return;
    }

    const confirmed = await this.confirm.ask({
      title: 'Очистить историю снимков?',
      message:
        'Все накопленные снимки стоимости будут удалены безвозвратно: график динамики ' +
        'и просадка обнулятся и начнут копиться заново со следующего снимка.',
      confirmLabel: 'Очистить',
      danger: true,
    });
    if (confirmed) await this.snapshots.clearHistory();
  }

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
  private static readonly EMPTY_CASH: Cash = { cashRub: 0, totalValueRub: 0 };

  protected readonly totals = computed<Effectiveness>(
    () => this.summary.value()?.totals ?? DashboardPage.EMPTY,
  );
  protected readonly cash = computed<Cash>(
    () => this.summary.value()?.cash ?? DashboardPage.EMPTY_CASH,
  );

  /** Строки разреза — по системам или по портфелям */
  protected readonly effRows = computed<EffRow[]>(() => {
    const s = this.summary.value();
    if (!s) return [];
    // Аннотация обязательна: без неё тип выводится как объединение ДВУХ массивов
    // (bySystem[] | byPortfolio[]), а такое объединение не подходит под readonly T[]
    const rows: EffRow[] =
      this.groupBy() === 'system'
        ? s.bySystem.map((r) => ({ ...r, id: r.systemId }))
        : s.byPortfolio.map((r) => ({ ...r, id: r.portfolioId }));
    return rows;
  });

  protected readonly systemBars = computed(() =>
    (this.summary.value()?.bySystem ?? []).map((r) => ({ label: r.name, pnlRub: r.pnlRub })),
  );

  protected readonly instrumentBars = computed(() =>
    (this.summary.value()?.breakdown ?? []).map((r) => ({ label: r.ticker, pnlRub: r.pnlRub })),
  );

  /**
   * Снимки по возрастанию даты, обрезанные под выбранный период (для просадки и
   * бенчмарка). Снимки не разбиты по системам/портфелям (см. filter.segmented),
   * поэтому фильтр системы/портфеля их не сужает.
   */
  protected readonly snaps = computed(() => {
    const all = [...(this.snapshots.list.value() ?? [])].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    const r = this.filter.range();
    return all.filter((s) => (!r.from || s.date >= r.from) && (!r.till || s.date <= r.till));
  });

  /** Просадка в процентах; null — снимков меньше двух, считать не из чего */
  protected readonly maxDrawdownPct = computed(() => {
    const s = this.snaps();
    if (s.length < 2) return null;
    return maxDrawdown(s.map((r) => r.currentValueRub)) * 100;
  });

  /**
   * Окно запроса истории индекса — от первого (отфильтрованного по периоду) снимка
   * до сегодня. null (снимков меньше двух) означает «не запрашивать»: сравнивать
   * не с чем.
   */
  private readonly benchmarkRange = computed<BenchmarkRange | null>(() => {
    const s = this.snaps();
    if (s.length < 2) return null;
    return { from: s[0].date, till: new Date().toISOString().slice(0, 10) };
  });

  protected readonly benchmark = benchmarkResource(this.benchmarkRange);
}
