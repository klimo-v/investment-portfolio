import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatTabsModule } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { OperationApi } from '../../entities/operation/operation.api';
import { formatMoney, pnlColorClass } from '@web-shared';
import type { Trade } from '@core';

/**
 * Страница «Сделки» (docs/03-ux-plan.md, шаг 2). Только просмотр — полностью
 * строится из журнала операций движком (@core: calculateTrades).
 * Клик по строке раскрывает операции, из которых собрана сделка.
 */
@Component({
  selector: 'app-trades-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatTableModule, MatTabsModule, MatIconModule, NgTemplateOutlet],
  template: `
    <h1 class="page-title">Сделки</h1>

    @if (api.trades.isLoading()) {
      <p>Загрузка…</p>
    } @else if (api.trades.error()) {
      <p class="error">Не удалось загрузить сделки. Запущен ли API?</p>
    } @else {
      <mat-tab-group class="tabs">
        <mat-tab [label]="'Открытые (' + openTrades().length + ')'">
          <ng-container [ngTemplateOutlet]="table" [ngTemplateOutletContext]="{ rows: openTrades() }" />
        </mat-tab>
        <mat-tab [label]="'Закрытые (' + closedTrades().length + ')'">
          <ng-container [ngTemplateOutlet]="table" [ngTemplateOutletContext]="{ rows: closedTrades() }" />
        </mat-tab>
      </mat-tab-group>
    }

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

  private readonly trades = computed(() => this.api.trades.value() ?? []);

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
