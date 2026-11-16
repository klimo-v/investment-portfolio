import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { formatMoney, StateMessage } from '@web-shared';
import { ReferenceApi } from '../../entities/reference/reference.api';
import { DashboardFilters } from '../../widgets/dashboard-filters/dashboard-filters';
import { tradesResource } from '../../entities/trade/trade.api';
import {
  systemPerformanceResource,
  type SystemPerformanceFilter,
} from '../../entities/system-performance/system-performance.api';
import { queryParams } from '../../shared/query-param';
import { dashboardFilter } from '../../widgets/dashboard-filters/dashboard-filter.state';
import { SystemExecution } from '../../widgets/system-execution/system-execution';
import { SystemKpis } from '../../widgets/system-kpis/system-kpis';
import {
  SystemEquityChart,
  type EquityCurve,
} from '../../widgets/system-equity-chart/system-equity-chart';
import { SystemPnlBreakdown } from '../../widgets/system-pnl-breakdown/system-pnl-breakdown';
import { SystemTradeDistribution } from '../../widgets/system-trade-distribution/system-trade-distribution';
import { TradesTable } from '../../widgets/trades-table/trades-table';

/**
 * Страница «Система» (/systems/:systemId): подробная статистика результатов торговли
 * одной торговой системы. Ничего специфичного для конкретной системы или типа
 * инструмента: страница показывает то, что посчитал @core (systemPerformance) по
 * сделкам системы, будь то фьючерс или акции.
 *
 * Страница только собирает: данные — `systemPerformanceResource`, отображение —
 * виджеты. Фильтры (портфель, период) живут в адресной строке, как на дашборде, —
 * ссылка со страницы «Портфель» приносит с собой текущий портфель.
 *
 * Тяжёлые графики — в @defer (on viewport): Chart.js загружается, только когда до
 * них долистали.
 */
@Component({
  selector: 'app-system-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DashboardFilters,
    RouterLink,
    MatIconModule,
    StateMessage,
    SystemKpis,
    SystemExecution,
    SystemEquityChart,
    SystemPnlBreakdown,
    SystemTradeDistribution,
    TradesTable,
  ],
  template: `
    <div class="page-header">
      <h1 class="page-title">
        <a class="back" routerLink="/dashboard" [queryParams]="filter.linkParams()" aria-label="К дашборду"
          ><mat-icon>arrow_back</mat-icon></a
        >
        {{ title() }}
        @if (filter.label(); as label) {
          <span class="period-range">({{ label }})</span>
        }
      </h1>
      <app-dashboard-filters [showSystem]="false" />
    </div>

    @if (filter.calendarError()) {
      <app-state-message
        kind="error"
        title="Не удалось загрузить календарь портфеля"
        hint="Проверьте связь с сервером и повторите."
        retryLabel="Повторить"
        (retry)="filter.retryCalendar()"
      />
    } @else if (filter.calendarLoading()) {
      <p role="status">Загрузка календаря портфеля…</p>
    } @else if (filter.ready() && performance.isLoading()) {
      <p>Загрузка выбранного периода…</p>
    } @else if (filter.ready() && performance.error()) {
      <!-- 404: такой системы нет; прочее — сервер недоступен -->
      <app-state-message
        kind="error"
        [title]="notFound() ? 'Система не найдена' : 'Не удалось загрузить статистику'"
        [hint]="
          notFound()
            ? 'Проверьте адрес или выберите систему на дашборде.'
            : 'Проверьте, что сервер запущен, и попробуйте ещё раз.'
        "
        [retryLabel]="notFound() ? '' : 'Повторить'"
        (retry)="performance.reload()"
      />
    } @else if (filter.ready() && performance.hasValue()) {
      <!-- hasValue(), а не !isLoading(): при смене фильтра прежние цифры остаются на экране -->
      @let p = performance.value();
      @if (!p.summary.hasActivity) {
        <app-state-message
          kind="empty"
          icon="query_stats"
          title="Нет данных за период"
          hint="За этот период нет сделок, выплат или удержаний. Выберите другой период."
        />
      } @else {
        @if (p.tradeMetrics.trades.closed === 0) {
          <app-state-message
            kind="empty"
            icon="query_stats"
            title="Нет закрытых сделок"
            hint="Показатели качества появятся после закрытия сделки."
          />
        }
        @for (rec of p.reconciliation; track rec.ticker + rec.portfolioId) {
          <p class="recon recon--{{ rec.status }}" role="status">
            <mat-icon>{{
              rec.status === 'ok'
                ? 'verified'
                : rec.status === 'mismatch'
                  ? 'warning'
                  : 'help_outline'
            }}</mat-icon>
            {{ rec.ticker }}:
            @switch (rec.status) {
              @case ('ok') {
                сверено с вариационной маржой брокера (отчёт на {{ rec.asOf }}).
              }
              @case ('mismatch') {
                расхождение с вариационной маржой брокера {{ money(rec.diffRub ?? '0') }} (журнал
                {{ money(rec.engineRub ?? '0') }}, брокер {{ money(rec.brokerRub) }}). Проверьте,
                что импортированы все сделки.
              }
              @default {
                сверить не удалось: {{ rec.reason }}
              }
            }
          </p>
        }
        <app-system-kpis [performance]="p" />

        <div class="charts">
          <div class="wide">
            @defer (on viewport) {
              <app-system-equity-chart
                [performance]="p"
                [curve]="curve()"
                [periodFrom]="filter.range().from ?? null"
                [periodTill]="filter.range().till ?? null"
                (curveChange)="setCurve($event)"
              />
            } @placeholder {
              <div class="chart-box"></div>
            }
          </div>
          @if (p.tradeMetrics.trades.closed > 0) {
            @defer (on viewport) {
              <app-system-pnl-breakdown [performance]="p" />
            } @placeholder {
              <div class="chart-box"></div>
            }
            @defer (on viewport) {
              <app-system-trade-distribution [performance]="p" />
            } @placeholder {
              <div class="chart-box"></div>
            }
          }
        </div>

        @if (p.execution; as execution) {
          <app-system-execution [execution]="execution" />
        }

        <h2 class="section-title">Сделки системы</h2>
        <section class="system-trades" aria-label="Сделки системы">
          @if (trades.isLoading()) {
            <p role="status">Загружаем сделки системы…</p>
          } @else if (trades.error()) {
            <app-state-message
              kind="error"
              title="Не удалось загрузить сделки системы"
              retryLabel="Повторить"
              (retry)="trades.reload()"
            />
          } @else if (trades.hasValue()) {
            <app-trades-table [trades]="trades.value()" />
          }
        </section>
      }
    }
  `,
  styles: [
    `
      .back {
        display: inline-flex;
        vertical-align: middle;
        color: inherit;
        margin-right: 4px;
      }
      .charts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
        gap: 16px;
        margin-bottom: 16px;
      }
      .charts .wide {
        grid-column: 1 / -1;
      }
      .recon {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 12px;
        font-size: 13px;
      }
      .recon--ok mat-icon {
        color: var(--app-success, #199e70);
      }
      .recon--mismatch mat-icon {
        color: var(--app-danger, #e34948);
      }
      .section-title {
        margin: 16px 0 8px;
        font-size: 18px;
        font-weight: 500;
      }
    `,
  ],
})
export class SystemPage {
  /** Из пути /systems/:systemId (withComponentInputBinding) */
  readonly systemId = input.required<string>();

  protected readonly reference = inject(ReferenceApi);
  protected readonly money = (v: string): string => formatMoney(v, 'RUB');
  protected readonly filter = dashboardFilter();

  /** Какая кривая на графике: по закрытым сделкам или результат системы. Живёт в адресе (?curve=) */
  private readonly params = queryParams();
  private readonly curveParam = this.params.read('curve');
  protected readonly curve = computed<EquityCurve>(() =>
    this.curveParam() === 'trades' ? 'trades' : 'result',
  );
  protected setCurve(value: EquityCurve): void {
    // «result» — значение по умолчанию, в адрес не пишем
    void this.params.patch({ curve: value === 'result' ? null : value });
  }

  private readonly performanceFilter = computed<SystemPerformanceFilter | null>(() => {
    if (!this.filter.ready()) return null;
    const r = this.filter.range();
    return {
      portfolioId: this.filter.portfolio() ?? undefined,
      from: r.from,
      till: r.till,
    };
  });

  protected readonly performance = systemPerformanceResource(this.systemId, this.performanceFilter);

  protected readonly title = computed(
    () =>
      (this.performance.hasValue() ? this.performance.value().systemName : null) ??
      (this.reference.systems.hasValue()
        ? this.reference.systems.value().find((s) => s.id === this.systemId())?.name
        : null) ??
      'Система',
  );

  protected readonly notFound = computed(() => {
    const err = this.performance.error() as { status?: number } | undefined;
    return err?.status === 404;
  });

  protected readonly trades = tradesResource(computed(() => {
    const filter = this.performanceFilter();
    return filter && this.performance.hasValue() && !this.performance.isLoading()
      ? { ...filter, systemId: this.systemId() } : null;
  }));
}
