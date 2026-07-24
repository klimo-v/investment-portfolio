import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { OperationApi } from '../../entities/operation/operation.api';
import { ReferenceApi } from '../../entities/reference/reference.api';
import { AddOperationDialog } from '../../features/add-operation/add-operation.dialog';
import { ReassignOperationsDialog } from '../../features/reassign-operations/reassign-operations.dialog';

/**
 * Страница «Операции» (docs/03-ux-plan.md, шаг 1).
 * Таблица журнала из реального API (httpResource) + кнопка добавления (Signal Forms).
 * Удаление и переназначение системы/портфеля — множественный выбор чекбоксами
 * (docs/04-roadmap.md §3.1: одна загрузка может содержать разные системы/счета).
 */
@Component({
  selector: 'app-operations-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatTableModule, MatButtonModule, MatIconModule, MatCheckboxModule],
  template: `
    <div class="header">
      <h1 class="page-title">Операции</h1>
      <div class="actions">
        @if (selected().size > 0) {
          <button mat-stroked-button [disabled]="reassigning()" (click)="openReassign()">
            <mat-icon>swap_horiz</mat-icon>
            Назначить систему/портфель ({{ selected().size }})
          </button>
          <button mat-stroked-button color="warn" [disabled]="deleting()" (click)="removeSelected()">
            <mat-icon>delete</mat-icon>
            Удалить ({{ selected().size }})
          </button>
        }
        <button mat-flat-button color="primary" (click)="openAdd()">
          <mat-icon>add</mat-icon>
          Добавить операцию
        </button>
      </div>
    </div>

    @if (api.operations.isLoading()) {
      <p>Загрузка…</p>
    } @else if (api.operations.error()) {
      <p class="error">Не удалось загрузить операции. Запущен ли API?</p>
    } @else {
      <mat-card>
        <div class="table-scroll">
        <table mat-table [dataSource]="rows()">
          <ng-container matColumnDef="select">
            <th mat-header-cell *matHeaderCellDef>
              <mat-checkbox
                [checked]="allSelected()"
                [indeterminate]="someSelected()"
                (change)="toggleAll($event.checked)"
              ></mat-checkbox>
            </th>
            <td mat-cell *matCellDef="let r">
              <mat-checkbox
                [checked]="selected().has(r.id)"
                (change)="toggleOne(r.id, $event.checked)"
              ></mat-checkbox>
            </td>
          </ng-container>
          <ng-container matColumnDef="date">
            <th mat-header-cell *matHeaderCellDef>Дата</th>
            <td mat-cell *matCellDef="let r">{{ r.date }}</td>
          </ng-container>
          <ng-container matColumnDef="system">
            <th mat-header-cell *matHeaderCellDef>Система</th>
            <td mat-cell *matCellDef="let r">{{ systemName(r.systemId) }}</td>
          </ng-container>
          <ng-container matColumnDef="portfolio">
            <th mat-header-cell *matHeaderCellDef>Портфель</th>
            <td mat-cell *matCellDef="let r">{{ portfolioName(r.portfolioId) }}</td>
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
          <tr mat-header-row *matHeaderRowDef="columns; sticky: true"></tr>
          <tr mat-row *matRowDef="let row; columns: columns"></tr>
        </table>
        </div>

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
      .actions {
        display: flex;
        gap: 8px;
      }
      .table-scroll {
        max-height: calc(100vh - 200px);
        overflow: auto;
      }
      table {
        width: 100%;
      }
      th {
        background: white;
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
  private readonly reference = inject(ReferenceApi);
  private readonly dialog = inject(MatDialog);

  protected readonly columns = [
    'select',
    'date',
    'system',
    'portfolio',
    'type',
    'ticker',
    'qty',
    'price',
  ];
  protected readonly rows = computed(() => this.api.operations.value() ?? []);

  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly deleting = signal(false);
  protected readonly reassigning = signal(false);

  private readonly systemNameById = computed(
    () => new Map((this.reference.systems.value() ?? []).map((s) => [s.id, s.name])),
  );
  private readonly portfolioNameById = computed(
    () => new Map((this.reference.portfolios.value() ?? []).map((p) => [p.id, p.name])),
  );

  protected systemName(id: string): string {
    return this.systemNameById().get(id) ?? id;
  }

  protected portfolioName(id: string): string {
    return this.portfolioNameById().get(id) ?? id;
  }

  protected readonly allSelected = computed(() => {
    const rows = this.rows();
    return rows.length > 0 && rows.every((r) => this.selected().has(r.id!));
  });

  protected readonly someSelected = computed(
    () => this.selected().size > 0 && !this.allSelected(),
  );

  protected openAdd(): void {
    this.dialog.open(AddOperationDialog, { autoFocus: false });
    // httpResource перезагрузится сам после add() внутри диалога (reloadTrigger)
  }

  protected toggleOne(id: string, checked: boolean): void {
    const next = new Set(this.selected());
    if (checked) next.add(id);
    else next.delete(id);
    this.selected.set(next);
  }

  protected toggleAll(checked: boolean): void {
    this.selected.set(checked ? new Set(this.rows().map((r) => r.id!)) : new Set());
  }

  protected async openReassign(): Promise<void> {
    const ids = [...this.selected()];
    if (ids.length === 0) return;

    const ref = this.dialog.open(ReassignOperationsDialog, {
      autoFocus: false,
      data: { count: ids.length },
    });
    const result = await firstValueFrom(ref.afterClosed());
    if (!result) return;

    this.reassigning.set(true);
    try {
      await this.api.reassign(ids, result);
      this.selected.set(new Set());
    } finally {
      this.reassigning.set(false);
    }
  }

  protected async removeSelected(): Promise<void> {
    const ids = [...this.selected()];
    if (ids.length === 0) return;
    const confirmed = confirm(
      `Удалить ${ids.length} операц${ids.length === 1 ? 'ию' : 'ий'} без возможности восстановления? Вы точно уверены?`,
    );
    if (!confirmed) return;

    this.deleting.set(true);
    try {
      await this.api.remove(ids);
      this.selected.set(new Set());
    } finally {
      this.deleting.set(false);
    }
  }
}
