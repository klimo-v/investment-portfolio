import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { BENCHMARK_INDEXES, DEFAULT_BENCHMARK, maxDrawdown, type Cash, type Effectiveness } from '@core';
import { StateMessage } from '@web-shared';
import { summaryResource, type SummaryFilter } from '../../entities/summary/summary.api';
import { benchmarkResource, type BenchmarkQuery } from '../../entities/benchmark/benchmark.api';
import { parseEnum, queryParams } from '../../shared/query-param';
import { valuationResource, type ValuationFilter } from '../../entities/valuation/valuation.api';
import { performanceResource, type PerformanceFilter } from '../../entities/performance/performance.api';
import { DataRevision } from '../../shared/data-revision';
import { DashboardFilters } from '../../widgets/dashboard-filters/dashboard-filters';
import { dashboardFilter } from '../../widgets/dashboard-filters/dashboard-filter.state';
import { SummaryKpis } from '../../widgets/summary-kpis/summary-kpis';
import { DataQuality } from '../../widgets/data-quality/data-quality';
import {
  EffectivenessTable,
  type EffGroupBy,
  type EffRow,
} from '../../widgets/effectiveness-table/effectiveness-table';
import { BenchmarkChart } from '../../widgets/benchmark-chart/benchmark-chart';
import { PositionsSeriesChart } from '../../widgets/positions-series-chart/positions-series-chart';
import { CashflowChart } from '../../widgets/cashflow-chart/cashflow-chart';
import { PnlBarChart } from '../../widgets/pnl-bar-chart/pnl-bar-chart';

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
    DataQuality,
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

    @if (summary.error() || performance.error()) {
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
      <app-data-quality [warnings]="performance.value()?.warnings ?? []" [carried]="performance.value()?.carried ?? []" />

      <app-summary-kpis
        [dataWarnings]="periodWarnings()"
        [totals]="totals()"
        [cash]="cash()"
        [performance]="performance.value()?.total"
        [drawdownPct]="maxDrawdownPct()"
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
              [values]="portfolioValues()"
              [benchmark]="benchmark.value()"
              [selected]="benchmarkSecid()"
              (selectedChange)="selectBenchmark($event)"
            />
          } @placeholder {
            <div class="chart-box"></div>
          }
        </div>

        <div class="wide">
          @defer (on viewport) {
            <app-positions-series-chart [series]="valuation.value()" />
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
  /** Фильтр читается из адресной строки — тем же способом, что и в виджете фильтров */
  protected readonly filter = dashboardFilter();

  protected readonly groupBy = signal<EffGroupBy>('system');

  /**
   * Результат за период = изменение стоимости портфеля минус внесённые деньги = зафиксированное
   * (продажи, дивиденды, купоны ВНУТРИ периода) + переоценка остатка ЗА период. Прибыль,
   * заработанная до начала периода, в него не входит. Раньше «P&L» брал переоценку за всю
   * историю удерживаемых позиций, из-за чего за «текущий год» он включал и прошлые годы.
   */
  protected readonly pnlHint =
    'Результат за период = зафиксированное (продажи, дивиденды, купоны внутри периода) + ' +
    'переоценка остатка именно за период. Прибыль, заработанная до начала периода, сюда не входит.';

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
   * Дневной ряд оценки по инструментам под тот же фильтр, что и сводка: из него — график
   * «Стоимость инструментов во времени», линия портфеля в «Портфель против рынка» и просадка.
   * Считается из журнала и истории цен, поэтому «Сделать снимок» больше не нужен.
   */
  private readonly valuationFilter = computed<ValuationFilter>(() => {
    const r = this.filter.range();
    return {
      groupBy: 'instrument',
      systemId: this.filter.system() ?? undefined,
      portfolioId: this.filter.portfolio() ?? undefined,
      from: r.from,
      till: r.till,
    };
  });
  protected readonly valuation = valuationResource(this.valuationFilter);

  /**
   * Единый расчёт доходности периода (GET /api/performance): карточки, линия «Портфель» против
   * рынка, просадка и таблица эффективности берутся из ОДНОГО DTO. Контур: выбрана система —
   * позиции системы (в пределах счёта, если он выбран); выбран счёт — его богатство; иначе весь журнал.
   */
  private readonly performanceFilter = computed<PerformanceFilter>(() => {
    const r = this.filter.range();
    const system = this.filter.system();
    const portfolio = this.filter.portfolio();
    return system
      ? { scope: 'system', id: system, portfolioId: portfolio ?? undefined, from: r.from, till: r.till }
      : portfolio
        ? { scope: 'portfolio', id: portfolio, from: r.from, till: r.till }
        : { scope: 'all', from: r.from, till: r.till };
  });
  protected readonly performance = performanceResource(this.performanceFilter);

  /** Предупреждения о данных, задевающие выбранный период: пропуски журнала и дыры в ценах на конец периода */
  protected readonly periodWarnings = computed(() => {
    const p = this.performance.value();
    return p ? p.warnings.filter((w) => w.inPeriod).length + p.carried.length : 0;
  });

  private static readonly EMPTY: Effectiveness = {
    investedRub: 0,
    currentValueRub: 0,
    realizedPnlRub: 0,
    unrealizedPnlRub: 0,
    dividendsRub: 0,
    pnlRub: 0,
    dividendYieldPct: null,
  };
  private static readonly EMPTY_CASH: Cash = { cashRub: 0, totalValueRub: 0 };

  protected readonly totals = computed<Effectiveness>(
    () => this.summary.value()?.totals ?? DashboardPage.EMPTY,
  );
  protected readonly cash = computed<Cash>(
    () => this.summary.value()?.cash ?? DashboardPage.EMPTY_CASH,
  );

  /**
   * Строки разреза — по системам или по портфелям: суммы на сегодня из сводки, доходность за
   * период из единого расчёта (по id). Строка без расчёта не показывается.
   */
  protected readonly effRows = computed<EffRow[]>(() => {
    const s = this.summary.value();
    const p = this.performance.value();
    if (!s || !p) return [];
    const bySystem = this.groupBy() === 'system';
    const sums = new Map<string, Effectiveness>(
      bySystem ? s.bySystem.map((r) => [r.systemId, r]) : s.byPortfolio.map((r) => [r.portfolioId, r]),
    );
    return (bySystem ? p.bySystem : p.byPortfolio).map((row) => {
      const e = sums.get(row.id) ?? DashboardPage.EMPTY;
      return {
        id: row.id,
        name: row.name,
        investedRub: e.investedRub,
        currentValueRub: e.currentValueRub,
        dividendsRub: e.dividendsRub,
        dividendYieldPct: e.dividendYieldPct,
        performance: row.performance,
      };
    });
  });

  /** «Результат по системам» — из того же расчёта, что и карточки: рубли за период, а не за всю историю */
  protected readonly systemBars = computed(() =>
    (this.performance.value()?.bySystem ?? [])
      .map((r) => ({ label: r.name, pnlRub: Number(r.performance.resultRub) }))
      .sort((a, b) => b.pnlRub - a.pnlRub),
  );

  protected readonly instrumentBars = computed(() =>
    (this.summary.value()?.breakdown ?? []).map((r) => ({ label: r.ticker, pnlRub: r.pnlRub })),
  );

  /**
   * Индекс доходности (TWR, база 100) без влияния ввода/вывода денег и продаж — ряд из того же
   * расчёта, что и карточка: последняя точка линии = карточка «Доходность стратегии».
   */
  protected readonly portfolioValues = computed(() =>
    (this.performance.value()?.total.twr.series ?? []).map((p) => ({ date: p.date, valueRub: p.index })),
  );

  /** Просадка индекса доходности в процентах; null — меньше двух дней, считать не из чего */
  protected readonly maxDrawdownPct = computed(() => {
    const v = this.portfolioValues();
    if (v.length < 2) return null;
    return maxDrawdown(v.map((r) => r.valueRub)) * 100;
  });

  /** Выбранный ориентир живёт в адресной строке (?benchmark=), как и остальной фильтр дашборда */
  private readonly urlParams = queryParams();
  private readonly rawBenchmark = this.urlParams.read('benchmark');
  protected readonly benchmarkSecid = computed(() =>
    parseEnum(this.rawBenchmark(), BENCHMARK_INDEXES.map((b) => b.secid), DEFAULT_BENCHMARK),
  );

  protected selectBenchmark(secid: string): void {
    void this.urlParams.patch({ benchmark: secid === DEFAULT_BENCHMARK ? null : secid });
  }

  /**
   * Окно запроса ориентира — ровно даты ряда TWR (от точки базы до конца): оба ряда нормируются
   * на 100 в один день. null (дней меньше двух) означает «не запрашивать»: сравнивать не с чем.
   */
  private readonly benchmarkQuery = computed<BenchmarkQuery | null>(() => {
    const s = this.portfolioValues();
    if (s.length < 2) return null;
    return { secid: this.benchmarkSecid(), from: s[0].date, till: s[s.length - 1].date };
  });

  protected readonly benchmark = benchmarkResource(this.benchmarkQuery);
}
