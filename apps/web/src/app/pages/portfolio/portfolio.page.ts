import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { OperationApi } from '../../entities/operation/operation.api';
import { formatMoney } from '@web-shared';

/**
 * Страница «Портфель» (docs/03-ux-plan.md, шаг 3).
 * Позиции из реального API (httpResource → /api/operations/positions),
 * которые бэкенд считает общим движком @core.
 */
@Component({
  selector: 'app-portfolio-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatTableModule],
  template: `
    <h1 class="page-title">Портфель</h1>

    <div class="totals">
      <mat-card>
        <mat-card-subtitle>Вложено</mat-card-subtitle>
        <mat-card-title>{{ investedTotal() }}</mat-card-title>
      </mat-card>
      <mat-card>
        <mat-card-subtitle>Позиций</mat-card-subtitle>
        <mat-card-title>{{ positions().length }}</mat-card-title>
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
          <ng-container matColumnDef="invested">
            <th mat-header-cell *matHeaderCellDef>Вложено</th>
            <td mat-cell *matCellDef="let r">{{ r.invested }}</td>
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
      .totals {
        display: flex;
        gap: 16px;
        margin-bottom: 16px;
      }
      .totals mat-card {
        padding: 16px;
        min-width: 200px;
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

  protected readonly columns = ['ticker', 'qty', 'avg', 'invested'];

  protected readonly positions = computed(() => this.api.positions.value() ?? []);

  protected readonly rows = computed(() =>
    this.positions().map((p) => ({
      ticker: p.ticker,
      qty: p.quantity,
      avg: formatMoney(p.avgBuyPrice, p.currency),
      invested: formatMoney(p.investedCcy, p.currency),
    })),
  );

  protected readonly investedTotal = computed(() => {
    const total = this.positions().reduce((acc, p) => acc + Number(p.investedRub), 0);
    return formatMoney(total.toFixed(2), 'RUB');
  });
}
