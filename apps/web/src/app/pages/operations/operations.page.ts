import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog } from '@angular/material/dialog';
import { OperationApi } from '../../entities/operation/operation.api';
import { AddOperationDialog } from '../../features/add-operation/add-operation.dialog';

/**
 * Страница «Операции» (docs/03-ux-plan.md, шаг 1).
 * Таблица журнала из реального API (httpResource) + кнопка добавления (Signal Forms).
 */
@Component({
  selector: 'app-operations-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatTableModule, MatButtonModule, MatIconModule],
  template: `
    <div class="header">
      <h1 class="page-title">Операции</h1>
      <button mat-flat-button color="primary" (click)="openAdd()">
        <mat-icon>add</mat-icon>
        Добавить операцию
      </button>
    </div>

    @if (api.operations.isLoading()) {
      <p>Загрузка…</p>
    } @else if (api.operations.error()) {
      <p class="error">Не удалось загрузить операции. Запущен ли API?</p>
    } @else {
      <mat-card>
        <table mat-table [dataSource]="rows()">
          <ng-container matColumnDef="date">
            <th mat-header-cell *matHeaderCellDef>Дата</th>
            <td mat-cell *matCellDef="let r">{{ r.date }}</td>
          </ng-container>
          <ng-container matColumnDef="type">
            <th mat-header-cell *matHeaderCellDef>Тип</th>
            <td mat-cell *matCellDef="let r">{{ r.operationType }}</td>
          </ng-container>
          <ng-container matColumnDef="ticker">
            <th mat-header-cell *matHeaderCellDef>Тикер</th>
            <td mat-cell *matCellDef="let r">{{ r.instrumentId || '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="qty">
            <th mat-header-cell *matHeaderCellDef>Кол-во</th>
            <td mat-cell *matCellDef="let r">{{ r.quantity }}</td>
          </ng-container>
          <ng-container matColumnDef="price">
            <th mat-header-cell *matHeaderCellDef>Цена</th>
            <td mat-cell *matCellDef="let r">{{ r.price }}</td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="columns"></tr>
          <tr mat-row *matRowDef="let row; columns: columns"></tr>
        </table>

        @if (rows().length === 0) {
          <p class="empty">Операций пока нет. Добавьте первую или импортируйте отчёт брокера.</p>
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
export class OperationsPage {
  protected readonly api = inject(OperationApi);
  private readonly dialog = inject(MatDialog);

  protected readonly columns = ['date', 'type', 'ticker', 'qty', 'price'];
  protected readonly rows = computed(() => this.api.operations.value() ?? []);

  protected openAdd(): void {
    this.dialog.open(AddOperationDialog, { autoFocus: false });
    // httpResource перезагрузится сам после add() внутри диалога (reloadTrigger)
  }
}
