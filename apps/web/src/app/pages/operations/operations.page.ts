import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSortModule, Sort } from '@angular/material/sort';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { OperationType } from '@core';
import { OperationApi } from '../../entities/operation/operation.api';
import { ReferenceApi } from '../../entities/reference/reference.api';
import { AddOperationDialog } from '../../features/add-operation/add-operation.dialog';
import { ReassignOperationsDialog } from '../../features/reassign-operations/reassign-operations.dialog';

/**
 * Страница «Операции» (docs/03-ux-plan.md, шаг 1).
 * Таблица журнала из реального API (httpResource) + кнопка добавления (Signal Forms).
 * Удаление и переназначение системы/портфеля — множественный выбор чекбоксами
 * (docs/04-roadmap.md §3.1: одна загрузка может содержать разные системы/счета).
 *
 * Сортировка/фильтр/пагинация — на клиенте: журнал целиком и так уже держится в
 * памяти (движок расчётов в libs/core требует всю историю целиком, частями её не
 * отдать), поэтому дублировать эту логику на бэке пока незачем (YAGNI). Если объём
 * операций вырастет на порядки, первым делом на сервер стоит вынести именно
 * постраничную выдачу этого списка — расчёты (`positions`/`trades`/`summary`) это
 * не затронет.
 */
@Component({
  selector: 'app-operations-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatCardModule,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSortModule,
    MatPaginatorModule,
  ],
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
        <div class="filters">
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Поиск</mat-label>
            <input
              matInput
              placeholder="Тикер, система, портфель…"
              [value]="search()"
              (input)="setSearch($any($event.target).value)"
            />
          </mat-form-field>
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Система</mat-label>
            <mat-select [value]="systemFilter()" (selectionChange)="setSystemFilter($event.value)">
              <mat-option [value]="null">Все</mat-option>
              @for (s of reference.systems.value(); track s.id) {
                <mat-option [value]="s.id">{{ s.name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Портфель</mat-label>
            <mat-select [value]="portfolioFilter()" (selectionChange)="setPortfolioFilter($event.value)">
              <mat-option [value]="null">Все</mat-option>
              @for (p of reference.portfolios.value(); track p.id) {
                <mat-option [value]="p.id">{{ p.name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Тип</mat-label>
            <mat-select [value]="typeFilter()" (selectionChange)="setTypeFilter($event.value)">
              <mat-option [value]="null">Все</mat-option>
              @for (t of operationTypes; track t) {
                <mat-option [value]="t">{{ t }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          @if (hasActiveFilters()) {
            <button mat-button (click)="resetFilters()">
              <mat-icon>filter_alt_off</mat-icon>
              Сбросить фильтры
            </button>
          }
        </div>

        <div class="table-scroll">
          <table mat-table matSort [dataSource]="pagedRows()" (matSortChange)="onSortChange($event)">
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
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Дата</th>
              <td mat-cell *matCellDef="let r">{{ r.date }}</td>
            </ng-container>
            <ng-container matColumnDef="system">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Система</th>
              <td mat-cell *matCellDef="let r">{{ systemName(r.systemId) }}</td>
            </ng-container>
            <ng-container matColumnDef="portfolio">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Портфель</th>
              <td mat-cell *matCellDef="let r">{{ portfolioName(r.portfolioId) }}</td>
            </ng-container>
            <ng-container matColumnDef="type">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Тип</th>
              <td mat-cell *matCellDef="let r">{{ r.operationType }}</td>
            </ng-container>
            <ng-container matColumnDef="ticker">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Тикер</th>
              <td mat-cell *matCellDef="let r">{{ r.instrumentId || '—' }}</td>
            </ng-container>
            <ng-container matColumnDef="qty">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Кол-во</th>
              <td mat-cell *matCellDef="let r">{{ r.quantity }}</td>
            </ng-container>
            <ng-container matColumnDef="price">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Цена</th>
              <td mat-cell *matCellDef="let r">{{ r.price }}</td>
            </ng-container>
            <tr mat-header-row *matHeaderRowDef="columns; sticky: true"></tr>
            <tr mat-row *matRowDef="let row; columns: columns"></tr>
          </table>
        </div>

        @if (allRows().length === 0) {
          <p class="empty">Операций пока нет. Добавьте первую или импортируйте отчёт брокера.</p>
        } @else if (filteredRows().length === 0) {
          <p class="empty">Нет операций по заданным фильтрам.</p>
        } @else {
          <mat-paginator
            [length]="filteredRows().length"
            [pageIndex]="pageIndex()"
            [pageSize]="pageSize()"
            [pageSizeOptions]="[10, 25, 50, 100]"
            (page)="onPage($event)"
          ></mat-paginator>
        }
      </mat-card>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }
      .header {
        flex: 0 0 auto;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .actions {
        display: flex;
        gap: 8px;
      }
      mat-card {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }
      .filters {
        flex: 0 0 auto;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding: 12px 12px 0;
      }
      .filters mat-form-field {
        width: 180px;
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
      .error {
        color: #c62828;
      }
      .empty {
        padding: 24px;
        text-align: center;
        color: rgba(0, 0, 0, 0.6);
      }
      mat-paginator {
        flex: 0 0 auto;
      }
    `,
  ],
})
export class OperationsPage {
  protected readonly api = inject(OperationApi);
  protected readonly reference = inject(ReferenceApi);
  private readonly dialog = inject(MatDialog);

  protected readonly operationTypes = OperationType.options;

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

  protected readonly allRows = computed(() => this.api.operations.value() ?? []);

  protected readonly search = signal('');
  protected readonly systemFilter = signal<string | null>(null);
  protected readonly portfolioFilter = signal<string | null>(null);
  protected readonly typeFilter = signal<OperationType | null>(null);
  protected readonly sortState = signal<Sort>({ active: 'date', direction: 'desc' });
  protected readonly pageIndex = signal(0);
  protected readonly pageSize = signal(25);

  protected readonly hasActiveFilters = computed(
    () =>
      this.search().trim().length > 0 ||
      this.systemFilter() !== null ||
      this.portfolioFilter() !== null ||
      this.typeFilter() !== null,
  );

  /** Отфильтрованный (но ещё не отсортированный/не постраничный) срез журнала */
  protected readonly filteredRows = computed(() => {
    const system = this.systemFilter();
    const portfolio = this.portfolioFilter();
    const type = this.typeFilter();
    const query = this.search().trim().toLowerCase();

    return this.allRows().filter((r) => {
      if (system && r.systemId !== system) return false;
      if (portfolio && r.portfolioId !== portfolio) return false;
      if (type && r.operationType !== type) return false;
      if (query) {
        const haystack = [
          r.date,
          this.systemName(r.systemId),
          this.portfolioName(r.portfolioId),
          r.operationType,
          r.instrumentId ?? '',
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  });

  private readonly sortedRows = computed(() => {
    const { active, direction } = this.sortState();
    const rows = [...this.filteredRows()];
    if (!direction) return rows;

    const dir = direction === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      switch (active) {
        case 'date':
          return a.date.localeCompare(b.date) * dir;
        case 'system':
          return this.systemName(a.systemId).localeCompare(this.systemName(b.systemId)) * dir;
        case 'portfolio':
          return (
            this.portfolioName(a.portfolioId).localeCompare(this.portfolioName(b.portfolioId)) * dir
          );
        case 'type':
          return a.operationType.localeCompare(b.operationType) * dir;
        case 'ticker':
          return (a.instrumentId ?? '').localeCompare(b.instrumentId ?? '') * dir;
        case 'qty':
          return (Number(a.quantity) - Number(b.quantity)) * dir;
        case 'price':
          return (Number(a.price) - Number(b.price)) * dir;
        default:
          return 0;
      }
    });
    return rows;
  });

  /** Текущая страница — то, что реально попадает в `mat-table` */
  protected readonly pagedRows = computed(() => {
    const start = this.pageIndex() * this.pageSize();
    return this.sortedRows().slice(start, start + this.pageSize());
  });

  /**
   * MatPaginator сам не подрезает pageIndex, если length уменьшился (например,
   * после массового удаления на последней странице) — без этого таблица осталась
   * бы пустой, хотя данные есть на предыдущих страницах.
   */
  private readonly clampPageIndex = effect(() => {
    const pageCount = Math.max(1, Math.ceil(this.filteredRows().length / this.pageSize()));
    if (this.pageIndex() > pageCount - 1) {
      this.pageIndex.set(pageCount - 1);
    }
  });

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

  /** «Выбрать всё» — по всем операциям, подходящим под фильтр (а не только на странице) */
  protected readonly allSelected = computed(() => {
    const rows = this.filteredRows();
    return rows.length > 0 && rows.every((r) => this.selected().has(r.id!));
  });

  protected readonly someSelected = computed(
    () => this.selected().size > 0 && !this.allSelected(),
  );

  protected setSearch(value: string): void {
    this.search.set(value);
    this.pageIndex.set(0);
  }

  protected setSystemFilter(value: string | null): void {
    this.systemFilter.set(value);
    this.pageIndex.set(0);
  }

  protected setPortfolioFilter(value: string | null): void {
    this.portfolioFilter.set(value);
    this.pageIndex.set(0);
  }

  protected setTypeFilter(value: OperationType | null): void {
    this.typeFilter.set(value);
    this.pageIndex.set(0);
  }

  protected resetFilters(): void {
    this.search.set('');
    this.systemFilter.set(null);
    this.portfolioFilter.set(null);
    this.typeFilter.set(null);
    this.pageIndex.set(0);
  }

  protected onSortChange(sort: Sort): void {
    this.sortState.set(sort);
    this.pageIndex.set(0);
  }

  protected onPage(event: PageEvent): void {
    this.pageIndex.set(event.pageIndex);
    this.pageSize.set(event.pageSize);
  }

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
    this.selected.set(checked ? new Set(this.filteredRows().map((r) => r.id!)) : new Set());
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
      `Удалить ${ids.length} операц${ids.length === 1 ? 'ию' : 'ий'} без возможности восстановления? ` +
        'Это также сотрёт накопленную историю снимков портфеля (просадка и график динамики на дашборде) — ' +
        'она начнёт копиться заново со следующего «Обновить цены». Вы точно уверены?',
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
