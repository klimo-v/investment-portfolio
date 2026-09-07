import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSortModule, type Sort } from '@angular/material/sort';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { OperationType, type Operation } from '@core';
import {
  clampPageIndex,
  ConfirmService,
  pageSlice,
  sortRows,
  StateMessage,
  type SortKey,
  type SortState,
} from '@web-shared';
import { OperationApi } from '../../entities/operation/operation.api';
import { ReferenceApi } from '../../entities/reference/reference.api';
import { AddOperationDialog } from '../../features/add-operation/add-operation.dialog';
import { ReassignOperationsDialog } from '../../features/reassign-operations/reassign-operations.dialog';
import { queryParams } from '../../shared/query-param';

/** Операция журнала, готовая к показу: имена справочников и строка поиска подставлены */
export interface OperationRow extends Operation {
  id: string;
  systemName: string;
  portfolioName: string;
  /** Склеенные в нижнем регистре поля, по которым ищет строка поиска */
  haystack: string;
}

/** Активный срез журнала; null/пусто в поле означает «не фильтровать по нему» */
export interface OperationFilter {
  systemId: string | null;
  portfolioId: string | null;
  type: OperationType | null;
  query: string;
}

/**
 * Отбор строк журнала. Отдельная чистая функция, а не тело computed'а: это единственное
 * место, где решается, что пользователь увидит после ввода в поиск, и его нужно
 * проверять тестом без TestBed.
 *
 * Поиск идёт по заранее склеенному `haystack` (см. displayRows) — иначе строка
 * собиралась бы заново для каждой записи на каждый введённый символ.
 */
export function filterOperations(
  rows: readonly OperationRow[],
  filter: OperationFilter,
): OperationRow[] {
  const query = filter.query.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter.systemId && r.systemId !== filter.systemId) return false;
    if (filter.portfolioId && r.portfolioId !== filter.portfolioId) return false;
    if (filter.type && r.operationType !== filter.type) return false;
    if (query && !r.haystack.includes(query)) return false;
    return true;
  });
}

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
    StateMessage,
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

    @if (api.operations.error()) {
      <app-state-message
        kind="error"
        title="Не удалось загрузить операции"
        hint="Проверьте, что сервер запущен, и попробуйте ещё раз."
        retryLabel="Повторить"
        (retry)="api.reload()"
      />
      <!-- hasValue(), а не !isLoading(): при перезагрузке (удаление, добавление,
           переназначение) таблица не должна схлопываться — см. дашборд -->
    } @else if (api.operations.hasValue()) {
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
          <!-- matSortActive/Direction обязательны: без них таблица отсортирована по
               дате вниз, а стрелка в заголовке этого не показывает -->
          <table
            mat-table
            matSort
            [matSortActive]="sortState().active"
            [matSortDirection]="sortState().direction"
            [dataSource]="pagedRows()"
            (matSortChange)="onSortChange($event)"
          >
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
              <td mat-cell *matCellDef="let r">{{ r.systemName }}</td>
            </ng-container>
            <ng-container matColumnDef="portfolio">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Портфель</th>
              <td mat-cell *matCellDef="let r">{{ r.portfolioName }}</td>
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
          <app-state-message
            kind="empty"
            title="Операций пока нет"
            hint="Добавьте первую операцию или загрузите отчёт брокера на странице «Импорт»."
          />
        } @else if (filteredRows().length === 0) {
          <app-state-message
            kind="empty"
            icon="filter_alt_off"
            title="Нет операций по заданным фильтрам"
            retryLabel="Сбросить фильтры"
            (retry)="resetFilters()"
          />
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
      /* .filters — глобальный (styles.scss): четыре поля по 180px в один ряд
         требовали ≥768px, теперь ряд переносится */
      .filters {
        flex: 0 0 auto;
        padding: 12px 12px 0;
      }
      .table-scroll {
        flex: 1;
        min-height: 0;
        overflow: auto;
      }
      table {
        width: 100%;
      }
      /* Липкий заголовок непрозрачен, иначе строки просвечивают при скролле */
      th {
        background: var(--app-table-header-bg);
      }
      /* .error — глобальный (styles.scss) */
      mat-paginator {
        flex: 0 0 auto;
      }
    `,
  ],
})
export class OperationsPage {
  protected readonly api = inject(OperationApi);
  private readonly confirm = inject(ConfirmService);
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

  private readonly systemNameById = computed(
    () => new Map((this.reference.systems.value() ?? []).map((s) => [s.id, s.name])),
  );
  private readonly portfolioNameById = computed(
    () => new Map((this.reference.portfolios.value() ?? []).map((p) => [p.id, p.name])),
  );

  /**
   * Журнал, подготовленный к показу: имена системы и портфеля подставлены один раз,
   * а не на каждый вызов из шаблона и из компаратора сортировки. `haystack` —
   * заранее склеенная строка для поиска: раньше она собиралась заново для КАЖДОЙ
   * строки на КАЖДЫЙ введённый символ.
   *
   * Пересчитывается только при смене журнала или справочников — не при фильтрации,
   * сортировке и листании.
   */
  private readonly displayRows = computed(() => {
    const systems = this.systemNameById();
    const portfolios = this.portfolioNameById();
    return this.allRows().map((op) => {
      const systemName = systems.get(op.systemId) ?? op.systemId;
      const portfolioName = portfolios.get(op.portfolioId) ?? op.portfolioId;
      return {
        ...op,
        // Список из API всегда с id; пустая строка — чтобы не тащить `!` в разметку
        id: op.id ?? '',
        systemName,
        portfolioName,
        haystack: [op.date, systemName, portfolioName, op.operationType, op.instrumentId ?? '']
          .join(' ')
          .toLowerCase(),
      };
    });
  });

  /**
   * Фильтры журнала живут в АДРЕСНОЙ СТРОКЕ (shared/query-param.ts): отобранный
   * срез переживает переход на другую страницу и F5, и им можно поделиться ссылкой.
   * Сортировка и пагинация — намеренно НЕ в URL: это способ листать, а не срез
   * данных, и в ссылке они были бы шумом.
   */
  private readonly params = queryParams();

  /**
   * Поиск — ЛОКАЛЬНЫЙ сигнал, посеянный из адреса один раз, а не производный от него.
   * Если бы значение поля возвращалось из URL, быстрый набор ронял бы символы:
   * навигация по «a» успевает завершиться, когда в поле уже «ab», и связывание
   * [value] откатило бы поле назад. В URL значение уходит односторонне (setSearch).
   */
  protected readonly search = signal(this.params.read('q')() ?? '');
  protected readonly systemFilter = this.params.read('system');
  protected readonly portfolioFilter = this.params.read('portfolio');

  private readonly rawType = this.params.read('type');
  /** Неизвестный тип в адресе (правка руками, старая ссылка) — как будто фильтра нет */
  protected readonly typeFilter = computed<OperationType | null>(() => {
    const raw = this.rawType();
    return (OperationType.options as readonly string[]).includes(raw ?? '')
      ? (raw as OperationType)
      : null;
  });

  protected readonly sortState = signal<SortState>({ active: 'date', direction: 'desc' });
  protected readonly pageSize = signal(25);

  /**
   * Текущая страница. linkedSignal, а не signal + effect: страница сохраняется, пока
   * она существует, и подрезается, когда список схлопнулся (сработал фильтр, удалили
   * строки). Раньше это делал effect, писавший в сигнал — MatPaginator успевал
   * отрисоваться с «страница 3 из 1» до того, как эффект его поправит.
   */
  protected readonly pageIndex = linkedSignal<{ total: number; size: number }, number>({
    source: () => ({ total: this.filteredRows().length, size: this.pageSize() }),
    computation: ({ total, size }, previous) => clampPageIndex(previous?.value ?? 0, total, size),
  });

  protected readonly hasActiveFilters = computed(
    () =>
      this.search().trim().length > 0 ||
      this.systemFilter() !== null ||
      this.portfolioFilter() !== null ||
      this.typeFilter() !== null,
  );

  /** Отфильтрованный (но ещё не отсортированный/не постраничный) срез журнала */
  protected readonly filteredRows = computed(() =>
    filterOperations(this.displayRows(), {
      systemId: this.systemFilter(),
      portfolioId: this.portfolioFilter(),
      type: this.typeFilter(),
      query: this.search(),
    }),
  );

  /** Ключ сортировки колонки — механика сравнения общая (web-shared: sortRows) */
  private sortKey(row: OperationRow, column: string): SortKey {
    switch (column) {
      case 'date':
        return row.date;
      case 'system':
        return row.systemName;
      case 'portfolio':
        return row.portfolioName;
      case 'type':
        return row.operationType;
      case 'ticker':
        return row.instrumentId ?? '';
      case 'qty':
        return Number(row.quantity);
      case 'price':
        return Number(row.price);
      default:
        return null;
    }
  }

  private readonly sortedRows = computed(() =>
    sortRows(this.filteredRows(), this.sortState(), (row, column) => this.sortKey(row, column)),
  );

  /** Текущая страница — то, что реально попадает в `mat-table` */
  protected readonly pagedRows = computed(() =>
    pageSlice(this.sortedRows(), this.pageIndex(), this.pageSize()),
  );

  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly deleting = signal(false);
  protected readonly reassigning = signal(false);

  /** «Выбрать всё» — по всем операциям, подходящим под фильтр (а не только на странице) */
  protected readonly allSelected = computed(() => {
    const rows = this.filteredRows();
    return rows.length > 0 && rows.every((r) => this.selected().has(r.id));
  });

  protected readonly someSelected = computed(
    () => this.selected().size > 0 && !this.allSelected(),
  );

  protected setSearch(value: string): void {
    this.search.set(value);
    this.params.patch({ q: value });
    this.pageIndex.set(0);
  }

  protected setSystemFilter(value: string | null): void {
    this.params.patch({ system: value });
    this.pageIndex.set(0);
  }

  protected setPortfolioFilter(value: string | null): void {
    this.params.patch({ portfolio: value });
    this.pageIndex.set(0);
  }

  protected setTypeFilter(value: OperationType | null): void {
    this.params.patch({ type: value });
    this.pageIndex.set(0);
  }

  protected resetFilters(): void {
    this.search.set('');
    // Все четыре параметра ОДНОЙ навигацией: по одному вызову на параметр роутер
    // гасит предыдущую навигацию, и из адреса вычищался только последний
    this.params.patch({ q: null, system: null, portfolio: null, type: null });
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
    // maxWidth обязателен: дефолтные 80vw MatDialog'а на телефоне уже дают
    // горизонтальный скролл (вторая половина починки — сетка внутри диалога)
    this.dialog.open(AddOperationDialog, { autoFocus: false, maxWidth: '95vw' });
    // httpResource перезагрузится сам после add() внутри диалога (reloadTrigger)
  }

  protected toggleOne(id: string, checked: boolean): void {
    const next = new Set(this.selected());
    if (checked) next.add(id);
    else next.delete(id);
    this.selected.set(next);
  }

  protected toggleAll(checked: boolean): void {
    this.selected.set(checked ? new Set(this.filteredRows().map((r) => r.id)) : new Set());
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
    const confirmed = await this.confirm.ask({
      title: `Удалить ${ids.length} операц${ids.length === 1 ? 'ию' : 'ий'}?`,
      message:
        'Восстановить их будет нельзя.\n\n' +
        'Уже снятые снимки портфеля (просадка и график динамики на дашборде) станут ' +
        'недостоверными. Историю снимков не стираем — на дашборде загорится ' +
        'предупреждение с таблицей изменений.',
      confirmLabel: 'Удалить',
      danger: true,
    });
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
