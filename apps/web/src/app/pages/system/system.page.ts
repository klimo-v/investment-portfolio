import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
import { formatMoney, StateMessage } from '@web-shared';
import { OperationApi } from '../../entities/operation/operation.api';
import { ReferenceApi } from '../../entities/reference/reference.api';
import { TradeApi } from '../../entities/trade/trade.api';
import {
  systemPerformanceResource,
  type SystemPerformanceFilter,
} from '../../entities/system-performance/system-performance.api';
import { dashboardFilter } from '../../widgets/dashboard-filters/dashboard-filter.state';
import { SystemExecution } from '../../widgets/system-execution/system-execution';
import { SystemKpis } from '../../widgets/system-kpis/system-kpis';
import { SystemEquityChart } from '../../widgets/system-equity-chart/system-equity-chart';
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
    RouterLink,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatSelectModule,
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
        <a class="back" routerLink="/dashboard" aria-label="К дашборду"><mat-icon>arrow_back</mat-icon></a>
        {{ title() }}
        @if (filter.label(); as label) {
          <span class="period-range">({{ label }})</span>
        }
      </h1>
      <div class="filters">
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>Портфель</mat-label>
          <mat-select [value]="filter.portfolio()" (selectionChange)="filter.setPortfolio($event.value)">
            <mat-option [value]="null">Все</mat-option>
            @for (p of reference.portfolios.value(); track p.id) {
              <mat-option [value]="p.id">{{ p.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-button-toggle-group
          [value]="filter.period()"
          (change)="filter.setPeriod($event.value)"
          hideSingleSelectionIndicator
          aria-label="Период"
        >
          <mat-button-toggle value="ytd">YTD</mat-button-toggle>
          <mat-button-toggle value="1y">1 год</mat-button-toggle>
          <mat-button-toggle value="all">Всё время</mat-button-toggle>
        </mat-button-toggle-group>
      </div>
    </div>

    @if (performance.error()) {
      <!-- 404: такой системы нет; прочее — сервер недоступен -->
      <app-state-message
        kind="error"
        [title]="notFound() ? 'Система не найдена' : 'Не удалось загрузить статистику'"
        [hint]="notFound() ? 'Проверьте адрес или выберите систему на дашборде.' : 'Проверьте, что сервер запущен, и попробуйте ещё раз.'"
        [retryLabel]="notFound() ? '' : 'Повторить'"
        (retry)="performance.reload()"
      />
    } @else if (performance.hasValue()) {
      <!-- hasValue(), а не !isLoading(): при смене фильтра прежние цифры остаются на экране -->
      @let p = performance.value();
      @if (p.trades.closed === 0 && p.summary.openCount === 0) {
        <app-state-message
          kind="empty"
          icon="query_stats"
          title="Нет сделок"
          hint="По этой системе за выбранный срез нет ни закрытых, ни открытых сделок. Импортируйте отчёт брокера или расширьте период."
        />
      } @else {
        @if (p.trades.closed === 0) {
          <app-state-message
            kind="empty"
            icon="query_stats"
            title="Нет закрытых сделок"
            hint="Показатели качества считаются только по закрытым сделкам. Открытая позиция показана в плашке «Открытые позиции»."
          />
        }
        @for (rec of p.reconciliation; track rec.ticker + rec.portfolioId) {
          <p class="recon recon--{{ rec.status }}" role="status">
            <mat-icon>{{ rec.status === 'ok' ? 'verified' : rec.status === 'mismatch' ? 'warning' : 'help_outline' }}</mat-icon>
            {{ rec.ticker }}:
            @switch (rec.status) {
              @case ('ok') {
                сверено с вариационной маржой брокера (отчёт на {{ rec.asOf }}).
              }
              @case ('mismatch') {
                расхождение с вариационной маржой брокера {{ money(rec.diffRub ?? '0') }} (журнал {{ money(rec.engineRub ?? '0') }}, брокер {{ money(rec.brokerRub) }}). Проверьте, что импортированы все сделки.
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
              <app-system-equity-chart [performance]="p" />
            } @placeholder {
              <div class="chart-box"></div>
            }
          </div>
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
        </div>

        @if (p.execution; as execution) {
          <app-system-execution [execution]="execution" />
        }

        <h2 class="section-title">Сделки системы</h2>
        <app-trades-table [trades]="systemTrades()" [operations]="operationApi.operations.value() ?? []" />
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
        grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
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
  protected readonly operationApi = inject(OperationApi);
  private readonly tradeApi = inject(TradeApi);
  protected readonly filter = dashboardFilter();

  private readonly performanceFilter = computed<SystemPerformanceFilter>(() => {
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
      this.performance.value()?.systemName ??
      this.reference.systems.value()?.find((s) => s.id === this.systemId())?.name ??
      'Система',
  );

  protected readonly notFound = computed(() => {
    const err = this.performance.error() as { status?: number } | undefined;
    return err?.status === 404;
  });

  /** Сделки этой системы в выбранном портфеле/периоде — для таблицы под графиками */
  protected readonly systemTrades = computed(() => {
    const portfolio = this.filter.portfolio();
    const { from, till } = this.filter.range();
    return (this.tradeApi.trades.value() ?? []).filter(
      (t) =>
        t.systemId === this.systemId() &&
        (!portfolio || t.portfolioId === portfolio) &&
        (!from || !t.closedAt || t.closedAt >= from) &&
        (!till || t.openedAt <= till),
    );
  });
}
