import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatTabsModule } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { OperationApi } from '../../entities/operation/operation.api';
import { ReferenceApi } from '../../entities/reference/reference.api';
import { formatMoney, pnlColorClass } from '@web-shared';
import { tradeStats, type Trade, type TradeStats, type TradeStatInput } from '@core';

interface StatsRow extends TradeStats {
  id: string;
  name: string;
}

/**
 * Страница «Сделки» (docs/03-ux-plan.md, шаг 2). Только просмотр — полностью
 * строится из журнала операций движком (@core: calculateTrades).
 * Два верхнеуровневых таба: список сделок (открытые/закрытые, с фильтром по
 * портфелю) и статистика эффективности стратегии по закрытым сделкам
 * (docs/05-review-usability.md §1.3) — в разрезе систем или портфелей.
 * Клик по строке раскрывает операции, из которых собрана сделка.
 */
@Component({
  selector: 'app-trades-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatCardModule,
    MatTableModule,
    MatTabsModule,
    MatIconModule,
    MatFormFieldModule,
    MatSelectModule,
    MatButtonToggleModule,
    NgTemplateOutlet,
  ],
  template: `
    <h1 class="page-title">Сделки</h1>

    @if (api.trades.isLoading()) {
      <p>Загрузка…</p>
    } @else if (api.trades.error()) {
      <p class="error">Не удалось загрузить сделки. Запущен ли API?</p>
    } @else {
      <mat-tab-group class="top-tabs">
        <mat-tab label="Открытые и закрытые">
          <div class="tab-content trades-tab-content">
            <div class="filters">
              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>Портфель</mat-label>
                <mat-select
                  [value]="portfolioFilter()"
                  (selectionChange)="portfolioFilter.set($event.value)"
                >
                  <mat-option [value]="null">Все</mat-option>
                  @for (p of reference.portfolios.value(); track p.id) {
                    <mat-option [value]="p.id">{{ p.name }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
            </div>

            <mat-tab-group class="tabs">
              <mat-tab [label]="'Открытые (' + openTrades().length + ')'">
                <ng-container [ngTemplateOutlet]="table" [ngTemplateOutletContext]="{ rows: openTrades() }" />
              </mat-tab>
              <mat-tab [label]="'Закрытые (' + closedTrades().length + ')'">
                <ng-container [ngTemplateOutlet]="table" [ngTemplateOutletContext]="{ rows: closedTrades() }" />
              </mat-tab>
            </mat-tab-group>
          </div>
        </mat-tab>

        <mat-tab label="Статистика">
          <div class="tab-content stats-tab-content">
            @if (overall().closedCount > 0) {
              <mat-card class="stats">
                <div class="stats-head">
                  <h3>Статистика закрытых сделок</h3>
                  <span class="muted">только зафиксированный результат</span>
                </div>
                <div class="kpis">
                  <div class="kpi">
                    <span class="kpi-label">Сделок</span>
                    <span class="kpi-value">{{ overall().closedCount }}</span>
                  </div>
                  <div class="kpi">
                    <span class="kpi-label">Win rate</span>
                    <span class="kpi-value">{{ overall().winRatePct.toFixed(0) }}%</span>
                  </div>
                  <div class="kpi">
                    <span class="kpi-label">Profit factor</span>
                    <span class="kpi-value">{{ pf(overall().profitFactor) }}</span>
                  </div>
                  <div class="kpi">
                    <span class="kpi-label">Ср. выигрыш</span>
                    <span class="kpi-value pnl-positive">{{ money(overall().avgWinRub) }}</span>
                  </div>
                  <div class="kpi">
                    <span class="kpi-label">Ср. убыток</span>
                    <span class="kpi-value pnl-negative">{{ money(overall().avgLossRub) }}</span>
                  </div>
                  <div class="kpi">
                    <span class="kpi-label">Матожидание</span>
                    <span class="kpi-value" [class]="pnlColorClass(overall().expectancyRub)">{{ money(overall().expectancyRub) }}</span>
                  </div>
                  <div class="kpi">
                    <span class="kpi-label">Ср. срок</span>
                    <span class="kpi-value">{{ overall().avgHoldingDays.toFixed(0) }} дн.</span>
                  </div>
                </div>

                <mat-button-toggle-group
                  class="stats-group-toggle"
                  [value]="statsGroupBy()"
                  (change)="statsGroupBy.set($event.value)"
                  hideSingleSelectionIndicator
                >
                  <mat-button-toggle value="system">По системам</mat-button-toggle>
                  <mat-button-toggle value="portfolio">По портфелям</mat-button-toggle>
                </mat-button-toggle-group>

                @if (statsGroupBy() === 'system') {
                  @if (bySystem().length > 1) {
                    <ng-container [ngTemplateOutlet]="statsTable" [ngTemplateOutletContext]="{ rows: bySystem(), nameLabel: 'Система' }" />
                  } @else {
                    <p class="muted stats-note">Недостаточно систем для разреза (нужно больше одной).</p>
                  }
                } @else {
                  @if (byPortfolio().length > 1) {
                    <ng-container [ngTemplateOutlet]="statsTable" [ngTemplateOutletContext]="{ rows: byPortfolio(), nameLabel: 'Портфель' }" />
                  } @else {
                    <p class="muted stats-note">Недостаточно портфелей для разреза (нужно больше одного).</p>
                  }
                }
              </mat-card>
            } @else {
              <p class="empty">Нет закрытых сделок для статистики.</p>
            }
          </div>
        </mat-tab>
      </mat-tab-group>
    }

    <ng-template #statsTable let-rows="rows" let-nameLabel="nameLabel">
      <table mat-table [dataSource]="rows" class="stats-table">
        <ng-container matColumnDef="name">
          <th mat-header-cell *matHeaderCellDef>{{ nameLabel }}</th>
          <td mat-cell *matCellDef="let r">{{ r.name }}</td>
        </ng-container>
        <ng-container matColumnDef="count">
          <th mat-header-cell *matHeaderCellDef>Сделок</th>
          <td mat-cell *matCellDef="let r">{{ r.closedCount }}</td>
        </ng-container>
        <ng-container matColumnDef="winrate">
          <th mat-header-cell *matHeaderCellDef>Win rate</th>
          <td mat-cell *matCellDef="let r">{{ r.winRatePct.toFixed(0) }}%</td>
        </ng-container>
        <ng-container matColumnDef="pf">
          <th mat-header-cell *matHeaderCellDef>Profit factor</th>
          <td mat-cell *matCellDef="let r">{{ pf(r.profitFactor) }}</td>
        </ng-container>
        <ng-container matColumnDef="avgwin">
          <th mat-header-cell *matHeaderCellDef>Ср. выигрыш</th>
          <td mat-cell *matCellDef="let r" class="pnl-positive">{{ money(r.avgWinRub) }}</td>
        </ng-container>
        <ng-container matColumnDef="avgloss">
          <th mat-header-cell *matHeaderCellDef>Ср. убыток</th>
          <td mat-cell *matCellDef="let r" class="pnl-negative">{{ money(r.avgLossRub) }}</td>
        </ng-container>
        <ng-container matColumnDef="expectancy">
          <th mat-header-cell *matHeaderCellDef>Матожидание</th>
          <td mat-cell *matCellDef="let r" [class]="pnlColorClass(r.expectancyRub)">{{ money(r.expectancyRub) }}</td>
        </ng-container>
        <ng-container matColumnDef="hold">
          <th mat-header-cell *matHeaderCellDef>Ср. срок</th>
          <td mat-cell *matCellDef="let r">{{ r.avgHoldingDays.toFixed(0) }} дн.</td>
        </ng-container>
        <tr mat-header-row *matHeaderRowDef="statsColumns"></tr>
        <tr mat-row *matRowDef="let row; columns: statsColumns"></tr>
      </table>
    </ng-template>

    <ng-template #table let-rows="rows">
      <mat-card class="table-card">
        @if (rows.length === 0) {
          <p class="empty">Сделок нет.</p>
        } @else {
        <div class="table-scroll">
          <table mat-table [dataSource]="rows" multiTemplateDataRows>
            <ng-container matColumnDef="status">
              <th mat-header-cell *matHeaderCellDef>Статус</th>
              <td mat-cell *matCellDef="let t">
                <span class="chip" [class]="'status-' + t.status.toLowerCase()">{{ statusLabel(t.status) }}</span>
              </td>
            </ng-container>
            <ng-container matColumnDef="ticker">
              <th mat-header-cell *matHeaderCellDef>Тикер</th>
              <td mat-cell *matCellDef="let t">{{ t.ticker }}</td>
            </ng-container>
            <ng-container matColumnDef="qty">
              <th mat-header-cell *matHeaderCellDef>Кол-во</th>
              <td mat-cell *matCellDef="let t">{{ t.quantity }} / {{ t.qtyBought }}</td>
            </ng-container>
            <ng-container matColumnDef="invested">
              <th mat-header-cell *matHeaderCellDef>Вложено (₽)</th>
              <td mat-cell *matCellDef="let t">{{ formatMoney(t.investedRub, 'RUB') }}</td>
            </ng-container>
            <ng-container matColumnDef="payouts">
              <th mat-header-cell *matHeaderCellDef>Див/купоны (₽)</th>
              <td mat-cell *matCellDef="let t">
                {{ formatMoney(plus(t.dividendsRub, t.couponsRub), 'RUB') }}
              </td>
            </ng-container>
            <ng-container matColumnDef="pnl">
              <th mat-header-cell *matHeaderCellDef>P&L (₽)</th>
              <td mat-cell *matCellDef="let t" [class]="pnlColorClass(t.pnlRub)">
                {{ formatMoney(t.pnlRub, 'RUB') }}
              </td>
            </ng-container>
            <ng-container matColumnDef="dates">
              <th mat-header-cell *matHeaderCellDef>Открыта / Закрыта</th>
              <td mat-cell *matCellDef="let t">{{ t.openedAt }} / {{ t.closedAt || '—' }}</td>
            </ng-container>
            <ng-container matColumnDef="expand">
              <th mat-header-cell *matHeaderCellDef></th>
              <td mat-cell *matCellDef="let t">
                <mat-icon>{{ expandedId() === t.id ? 'expand_less' : 'expand_more' }}</mat-icon>
              </td>
            </ng-container>

            <ng-container matColumnDef="detail">
              <td mat-cell *matCellDef="let t" [attr.colspan]="columns.length">
                @if (expandedId() === t.id) {
                  <div class="detail">
                    <p class="detail-title">Операции сделки:</p>
                    <ul>
                      @for (op of operationsFor(t); track op.id) {
                        <li>
                          {{ op.date }} — {{ op.operationType }} {{ op.quantity }} @ {{ op.price }}
                          @if (op.fee !== '0') { (комиссия {{ op.fee }}) }
                        </li>
                      }
                    </ul>
                  </div>
                }
              </td>
            </ng-container>

            <tr mat-header-row *matHeaderRowDef="columns; sticky: true"></tr>
            <tr
              mat-row
              *matRowDef="let row; columns: columns"
              class="clickable-row"
              (click)="toggle(row.id)"
            ></tr>
            <tr mat-row *matRowDef="let row; columns: ['detail']" class="detail-row"></tr>
          </table>
        </div>
        }
      </mat-card>
    </ng-template>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }
      .top-tabs {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .top-tabs ::ng-deep .mat-mdc-tab-body-wrapper,
      .top-tabs ::ng-deep .mat-mdc-tab-body,
      .top-tabs ::ng-deep .mat-mdc-tab-body-content {
        flex: 1;
        min-height: 0;
        height: 100%;
      }
      .tab-content {
        height: 100%;
      }
      .trades-tab-content {
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .stats-tab-content {
        overflow: auto;
        padding-top: 12px;
      }
      .filters {
        flex: 0 0 auto;
        display: flex;
        gap: 8px;
        padding: 12px 12px 0;
      }
      .filters mat-form-field {
        width: 220px;
      }
      .stats-group-toggle {
        margin-top: 12px;
      }
      .stats-note {
        margin: 12px 0 0;
        padding: 0;
        text-align: left;
      }
      .stats {
        flex: 0 0 auto;
        padding: 16px;
        margin-bottom: 12px;
        overflow-x: auto;
      }
      .stats-head {
        display: flex;
        align-items: baseline;
        gap: 8px;
        margin-bottom: 12px;
      }
      .stats-head h3 {
        margin: 0;
        font-weight: 500;
      }
      .muted {
        font-size: 12px;
        color: rgba(0, 0, 0, 0.5);
      }
      .kpis {
        display: flex;
        flex-wrap: wrap;
        gap: 24px;
      }
      .kpi {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .kpi-label {
        font-size: 12px;
        color: rgba(0, 0, 0, 0.6);
      }
      .kpi-value {
        font-size: 18px;
        font-weight: 500;
      }
      .stats-table {
        width: 100%;
        margin-top: 16px;
      }
      .tabs {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .tabs ::ng-deep .mat-mdc-tab-body-wrapper,
      .tabs ::ng-deep .mat-mdc-tab-body,
      .tabs ::ng-deep .mat-mdc-tab-body-content {
        flex: 1;
        min-height: 0;
        height: 100%;
      }
      .table-card {
        margin-top: 16px;
        height: calc(100% - 16px);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .table-scroll {
        flex: 1;
        min-height: 0;
        overflow: auto;
      }
      table {
        width: 100%;
      }
      th {
        background: white;
      }
      .clickable-row {
        cursor: pointer;
      }
      .detail-row td {
        border-bottom: none;
      }
      .detail {
        padding: 8px 0;
      }
      .detail-title {
        font-weight: 500;
        margin: 0 0 4px;
      }
      .detail ul {
        margin: 0;
        padding-left: 20px;
      }
      .chip {
        padding: 2px 8px;
        border-radius: 12px;
        font-size: 12px;
      }
      .status-open {
        background: #e3f2fd;
        color: #1565c0;
      }
      .status-partial {
        background: #fff3e0;
        color: #ef6c00;
      }
      .status-closed {
        background: #eceff1;
        color: #455a64;
      }
      .pnl-positive {
        color: #2e7d32;
      }
      .pnl-negative {
        color: #c62828;
      }
      .empty {
        padding: 24px;
        text-align: center;
        color: rgba(0, 0, 0, 0.6);
      }
      .error {
        color: #c62828;
      }
    `,
  ],
})
export class TradesPage {
  protected readonly api = inject(OperationApi);
  protected readonly reference = inject(ReferenceApi);

  protected readonly statsColumns = [
    'name',
    'count',
    'winrate',
    'pf',
    'avgwin',
    'avgloss',
    'expectancy',
    'hold',
  ];

  /** Вход для статистики: минимальные поля сделки, реализ. P&L строкой → числом */
  private readonly statInputs = computed<(TradeStatInput & { systemId: string; portfolioId: string })[]>(
    () =>
      (this.api.trades.value() ?? []).map((t) => ({
        systemId: t.systemId,
        portfolioId: t.portfolioId,
        status: t.status,
        realizedPnlRub: Number(t.realizedPnlRub),
        openedAt: t.openedAt,
        closedAt: t.closedAt,
      })),
  );

  /** Статистика по всем закрытым сделкам (не зависит от фильтра по портфелю — тот только для списка сделок) */
  protected readonly overall = computed<TradeStats>(() => tradeStats(this.statInputs()));

  /** Разрез статистики: по системам или по портфелям (переключатель под KPI) */
  protected readonly statsGroupBy = signal<'system' | 'portfolio'>('system');

  /** Статистика в разрезе систем (только с закрытыми сделками), по убыванию числа сделок */
  protected readonly bySystem = computed<StatsRow[]>(() => {
    const names = new Map((this.reference.systems.value() ?? []).map((s) => [s.id, s.name]));
    const byId = new Map<string, (TradeStatInput & { systemId: string })[]>();
    for (const t of this.statInputs()) {
      const arr = byId.get(t.systemId) ?? [];
      arr.push(t);
      byId.set(t.systemId, arr);
    }
    return [...byId.entries()]
      .map(([id, trades]) => ({ id, name: names.get(id) ?? id, ...tradeStats(trades) }))
      .filter((r) => r.closedCount > 0)
      .sort((a, b) => b.closedCount - a.closedCount);
  });

  /** Статистика в разрезе портфелей (только с закрытыми сделками), по убыванию числа сделок */
  protected readonly byPortfolio = computed<StatsRow[]>(() => {
    const names = new Map((this.reference.portfolios.value() ?? []).map((p) => [p.id, p.name]));
    const byId = new Map<string, (TradeStatInput & { portfolioId: string })[]>();
    for (const t of this.statInputs()) {
      const arr = byId.get(t.portfolioId) ?? [];
      arr.push(t);
      byId.set(t.portfolioId, arr);
    }
    return [...byId.entries()]
      .map(([id, trades]) => ({ id, name: names.get(id) ?? id, ...tradeStats(trades) }))
      .filter((r) => r.closedCount > 0)
      .sort((a, b) => b.closedCount - a.closedCount);
  });

  protected pf(value: number | null): string {
    return value === null ? '—' : value.toFixed(2);
  }

  protected money(value: number): string {
    return formatMoney(value.toFixed(2), 'RUB');
  }

  protected readonly columns = [
    'status',
    'ticker',
    'qty',
    'invested',
    'payouts',
    'pnl',
    'dates',
    'expand',
  ];

  protected readonly expandedId = signal<string | null>(null);

  /** Фильтр по портфелю — только для списка сделок (не влияет на статистику) */
  protected readonly portfolioFilter = signal<string | null>(null);

  private readonly trades = computed(() => {
    const portfolio = this.portfolioFilter();
    const all = this.api.trades.value() ?? [];
    return portfolio ? all.filter((t) => t.portfolioId === portfolio) : all;
  });

  protected readonly openTrades = computed(() =>
    this.trades().filter((t) => t.status !== 'Closed'),
  );
  protected readonly closedTrades = computed(() =>
    this.trades().filter((t) => t.status === 'Closed'),
  );

  protected toggle(id: string): void {
    this.expandedId.set(this.expandedId() === id ? null : id);
  }

  protected operationsFor(trade: Trade) {
    const ops = this.api.operations.value() ?? [];
    const ids = new Set(trade.operationIds);
    return ops.filter((op) => op.id && ids.has(op.id));
  }

  protected statusLabel(status: Trade['status']): string {
    return { Open: 'Открыта', Partial: 'Частично', Closed: 'Закрыта' }[status];
  }

  protected plus(a: string, b: string): string {
    return (Number(a) + Number(b)).toFixed(2);
  }

  protected readonly formatMoney = formatMoney;
  protected readonly pnlColorClass = pnlColorClass;
}
