import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog } from '@angular/material/dialog';
import { OperationApi } from '../../entities/operation/operation.api';
import { ManagePortfoliosDialog } from '../../features/manage-portfolios/manage-portfolios.dialog';
import { formatMoney, pnlColorClass } from '@web-shared';

/**
 * Страница «Портфель» (docs/03-ux-plan.md, шаг 3).
 * Позиции из API (движок @core на бэке), текущие цены — из котировок (MOEX/ЦБ).
 */
@Component({
  selector: 'app-portfolio-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatTableModule, MatButtonModule, MatIconModule],
  template: `
    <div class="header">
      <h1 class="page-title">Портфель</h1>
      <div class="actions">
        <button mat-stroked-button (click)="managePortfolios()">
          <mat-icon>account_balance</mat-icon>
          Портфели
        </button>
        <button mat-stroked-button (click)="refresh()" [disabled]="refreshing()">
          <mat-icon>refresh</mat-icon>
          {{ refreshing() ? 'Обновление…' : 'Обновить цены' }}
        </button>
      </div>
    </div>

    <div class="totals">
      <mat-card>
        <mat-card-subtitle>Вложено (₽)</mat-card-subtitle>
        <mat-card-title>{{ investedTotal() }}</mat-card-title>
      </mat-card>
      <mat-card>
        <mat-card-subtitle>Текущая стоимость (₽)</mat-card-subtitle>
        <mat-card-title>{{ valueTotal() }}</mat-card-title>
      </mat-card>
      <mat-card>
        <mat-card-subtitle>P&L (₽)</mat-card-subtitle>
        <mat-card-title [class]="pnlClass(pnlTotalRaw())">{{ pnlTotal() }}</mat-card-title>
      </mat-card>
    </div>

    @if (api.positions.isLoading()) {
      <p>Загрузка…</p>
    } @else if (api.positions.error()) {
      <p class="error">Не удалось загрузить позиции. Запущен ли API?</p>
    } @else {
      <mat-card>
        <table mat-table [dataSource]="rows()">
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

        @if (rows().length === 0) {
          <p class="empty">Позиций пока нет. Добавьте операции на странице «Операции».</p>
        }
      </mat-card>
    }
  `,
  styles: [
    `
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .actions {
        display: flex;
        gap: 8px;
      }
      .totals {
        display: flex;
        gap: 16px;
        margin-bottom: 16px;
      }
      .totals mat-card {
        padding: 16px;
        min-width: 180px;
      }
      table {
        width: 100%;
      }
      .error {
        color: #c62828;
      }
      .empty {
        padding: 24px;
        text-align: center;
        color: rgba(0, 0, 0, 0.6);
      }
    `,
  ],
})
export class PortfolioPage {
  protected readonly api = inject(OperationApi);
  private readonly dialog = inject(MatDialog);

  protected readonly columns = ['ticker', 'qty', 'avg', 'current', 'value', 'pnl'];
  protected readonly refreshing = signal(false);

  protected readonly positions = computed(() => this.api.positions.value() ?? []);

  protected readonly rows = computed(() =>
    this.positions().map((p) => ({
      ticker: p.ticker,
      qty: p.quantity,
      avg: formatMoney(p.avgBuyPrice, p.currency),
      current: p.currentPrice ? formatMoney(p.currentPrice, p.currency) : '—',
      value: p.currentValueRub ? formatMoney(p.currentValueRub, 'RUB') : '—',
      pnl: p.pnlRub ? formatMoney(p.pnlRub, 'RUB') : '—',
      pnlClass: p.pnlRub ? pnlColorClass(p.pnlRub) : 'pnl-zero',
    })),
  );

  protected readonly investedTotal = computed(() => {
    const total = this.positions().reduce((acc, p) => acc + Number(p.investedRub), 0);
    return formatMoney(total.toFixed(2), 'RUB');
  });

  protected readonly valueTotal = computed(() => {
    const total = this.positions().reduce((acc, p) => acc + Number(p.currentValueRub ?? 0), 0);
    return formatMoney(total.toFixed(2), 'RUB');
  });

  protected readonly pnlTotalRaw = computed(() =>
    this.positions().reduce((acc, p) => acc + Number(p.pnlRub ?? 0), 0),
  );

  protected readonly pnlTotal = computed(() => formatMoney(this.pnlTotalRaw().toFixed(2), 'RUB'));

  protected pnlClass(value: number): string {
    return pnlColorClass(value);
  }

  protected managePortfolios(): void {
    this.dialog.open(ManagePortfoliosDialog, { autoFocus: false });
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
