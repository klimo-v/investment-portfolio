import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatPaginatorModule, type PageEvent } from '@angular/material/paginator';
import { MatSortModule, type Sort } from '@angular/material/sort';
import type { Operation, Trade } from '@core';
import {
  clampPageIndex,
  formatMoney,
  pageSlice,
  pnlColorClass,
  sortRows,
  StateMessage,
  StatusChip,
  type ChipTone,
  type SortKey,
  type SortState,
} from '@web-shared';

const STATUS_LABEL: Record<Trade['status'], string> = {
  Open: 'Открыта',
  Partial: 'Частично',
  Closed: 'Закрыта',
};

const STATUS_TONE: Record<Trade['status'], ChipTone> = {
  Open: 'info',
  Partial: 'warn',
  Closed: 'neutral',
};

/** Порядок статусов «от живого к завершённому» — алфавитный тут бессмысленен */
const STATUS_RANK: Record<Trade['status'], number> = { Open: 0, Partial: 1, Closed: 2 };

/**
 * Список сделок: сортировка, пагинация и раскрытие операций, из которых сделка
 * собрана.
 *
 * Виджет намеренно держит своё состояние (сортировку, страницу, раскрытую строку)
 * внутри: на странице «Сделки» таких списков два — открытые и закрытые, — и до
 * выделения в компонент страница вручную вела по паре сигналов на каждый список и
 * раздавала их через ngTemplateOutlet-контекст. Два экземпляра компонента дают ту
 * же независимость даром.
 *
 * Пагинация клиентская: сделки не хранятся, их целиком пересобирает движок
 * (@core: calculateTrades) из всей истории операций — частями эту выборку не
 * отдать. Речь только о том, сколько DOM-строк рисовать.
 */
@Component({
  selector: 'app-trades-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatCardModule,
    MatTableModule,
    MatIconModule,
    MatButtonModule,
    MatPaginatorModule,
    MatSortModule,
    StateMessage,
    StatusChip,
  ],
  template: `
    <mat-card class="table-card">
      @if (trades().length === 0) {
        <app-state-message
          kind="empty"
          title="Сделок нет"
          hint="Сделки собираются из журнала операций автоматически — добавьте покупки и продажи."
        />
      } @else {
        <div class="table-scroll">
          <table
            mat-table
            matSort
            [matSortActive]="sort().active"
            [matSortDirection]="sort().direction"
            (matSortChange)="onSort($event)"
            [dataSource]="pagedRows()"
            multiTemplateDataRows
          >
            <ng-container matColumnDef="status">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Статус</th>
              <td mat-cell *matCellDef="let t">
                <app-status-chip [tone]="statusTone(t.status)">{{
                  statusLabel(t.status)
                }}</app-status-chip>
              </td>
            </ng-container>
            <ng-container matColumnDef="ticker">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Тикер</th>
              <td mat-cell *matCellDef="let t">{{ t.ticker }}</td>
            </ng-container>
            <ng-container matColumnDef="qty">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Кол-во</th>
              <td mat-cell *matCellDef="let t">{{ t.quantity }} / {{ t.qtyBought }}</td>
            </ng-container>
            <ng-container matColumnDef="invested">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Вложено (₽)</th>
              <td mat-cell *matCellDef="let t">{{ money(t.investedRub) }}</td>
            </ng-container>
            <ng-container matColumnDef="payouts">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Див/купоны (₽)</th>
              <td mat-cell *matCellDef="let t">{{ money(plus(t.dividendsRub, t.couponsRub)) }}</td>
            </ng-container>
            <ng-container matColumnDef="pnl">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>P&L (₽)</th>
              <td mat-cell *matCellDef="let t" [class]="cls(t.pnlRub)">{{ money(t.pnlRub) }}</td>
            </ng-container>
            <ng-container matColumnDef="dates">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Открыта / Закрыта</th>
              <td mat-cell *matCellDef="let t">{{ t.openedAt }} / {{ t.closedAt || '—' }}</td>
            </ng-container>
            <ng-container matColumnDef="expand">
              <th mat-header-cell *matHeaderCellDef></th>
              <td mat-cell *matCellDef="let t">
                <!--
                  Кнопка, а не голая mat-icon: раскрытие было доступно ТОЛЬКО кликом
                  по строке, то есть с клавиатуры операции сделки было не посмотреть.
                  stopPropagation — иначе клик дойдёт до строки и схлопнет обратно.
                -->
                <button
                  mat-icon-button
                  type="button"
                  [attr.aria-expanded]="expandedId() === t.id"
                  [attr.aria-label]="
                    (expandedId() === t.id ? 'Скрыть' : 'Показать') + ' операции сделки ' + t.ticker
                  "
                  (click)="$event.stopPropagation(); toggle(t.id)"
                >
                  <mat-icon>{{ expandedId() === t.id ? 'expand_less' : 'expand_more' }}</mat-icon>
                </button>
              </td>
            </ng-container>

            <ng-container matColumnDef="detail">
              <td mat-cell *matCellDef="let t" [attr.colspan]="columns.length">
                @if (expandedId() === t.id) {
                  <div class="detail">
                    <p class="detail-title">Операции сделки:</p>
                    <ul>
                      @for (op of expandedOperations(); track op.id) {
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

        <mat-paginator
          [length]="trades().length"
          [pageIndex]="pageIndex()"
          [pageSize]="pageSize()"
          [pageSizeOptions]="[25, 50, 100]"
          (page)="onPage($event)"
        ></mat-paginator>
      }
    </mat-card>
  `,
  styles: [
    `
      .table-card {
        margin-top: 16px;
      }
      /*
       * Только горизонтальный скролл: вертикальный отдан странице. Липкий заголовок
       * (sticky: true) липнет к ближайшему скроллящему предку — им и остаётся
       * .content из app.ts.
       */
      .table-scroll {
        overflow-x: auto;
      }
      table {
        width: 100%;
      }
      /* Липкий заголовок непрозрачен, иначе строки просвечивают при скролле */
      th {
        background: var(--app-table-header-bg);
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
      /* .pnl-* — глобальные (styles.scss), локальных копий не держим */
    `,
  ],
})
export class TradesTable {
  readonly trades = input<readonly Trade[]>([]);
  /** Журнал целиком — из него берутся операции раскрытой сделки */
  readonly operations = input<readonly Operation[]>([]);

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

  /**
   * По умолчанию — по дате открытия, свежие сверху. Порядок движка (@core:
   * calculateTrades) осмыслен внутри движка и произволен для читателя.
   */
  protected readonly sort = signal<SortState>({ active: 'dates', direction: 'desc' });
  protected readonly pageSize = signal(25);

  /**
   * linkedSignal: страница держится, пока существует, и подрезается, когда список
   * схлопнулся — иначе paginator утверждает «страница 3 из 1».
   */
  protected readonly pageIndex = linkedSignal<{ total: number; size: number }, number>({
    source: () => ({ total: this.trades().length, size: this.pageSize() }),
    computation: ({ total, size }, previous) => clampPageIndex(previous?.value ?? 0, total, size),
  });

  protected readonly expandedId = signal<string | null>(null);

  /**
   * Ключ сортировки колонки. Две колонки показывают ПАРУ значений — сортируем по
   * первому (тому, что читатель видит слева), вторым разрешаем ничью:
   * «Открыта / Закрыта» и «остаток / куплено». У закрытых сделок остаток всегда 0,
   * поэтому «Кол-во» там де-факто сортируется по купленному количеству.
   *
   * `pnlRub` приходит nullable (нет текущей цены → «—» в ячейке): отдаём null, и
   * такие строки уезжают вниз при любом направлении (см. web-shared/sorting.ts).
   */
  private sortKey(t: Trade, column: string): SortKey {
    switch (column) {
      case 'status':
        return STATUS_RANK[t.status];
      case 'ticker':
        return t.ticker;
      case 'qty':
        return [Number(t.quantity), Number(t.qtyBought)];
      case 'invested':
        return Number(t.investedRub);
      case 'payouts':
        return Number(t.dividendsRub) + Number(t.couponsRub);
      case 'pnl':
        return t.pnlRub === null ? null : Number(t.pnlRub);
      case 'dates':
        return [t.openedAt, t.closedAt];
      default:
        return null;
    }
  }

  private readonly sortedRows = computed(() =>
    sortRows(this.trades(), this.sort(), (t, c) => this.sortKey(t, c)),
  );

  protected readonly pagedRows = computed(() =>
    pageSlice(this.sortedRows(), this.pageIndex(), this.pageSize()),
  );

  /**
   * Операции раскрытой сделки. computed, а не метод из шаблона: тот вызывался на
   * каждом проходе change detection и заново прогонял весь журнал.
   */
  protected readonly expandedOperations = computed(() => {
    const id = this.expandedId();
    if (id === null) return [];
    const trade = this.trades().find((t) => t.id === id);
    if (!trade) return [];
    const ids = new Set(trade.operationIds);
    return this.operations().filter((op) => op.id && ids.has(op.id));
  });

  protected onSort(sort: Sort): void {
    this.sort.set(sort);
    this.pageIndex.set(0);
  }

  protected onPage(event: PageEvent): void {
    this.pageIndex.set(event.pageIndex);
    this.pageSize.set(event.pageSize);
  }

  protected toggle(id: string): void {
    this.expandedId.set(this.expandedId() === id ? null : id);
  }

  protected statusLabel(status: Trade['status']): string {
    return STATUS_LABEL[status];
  }

  protected statusTone(status: Trade['status']): ChipTone {
    return STATUS_TONE[status];
  }

  /** Дивиденды и купоны в одной ячейке — обе величины decimal-строки */
  protected plus(a: string, b: string): string {
    return (Number(a) + Number(b)).toFixed(2);
  }

  protected money(value: string | null): string {
    return value === null ? '—' : formatMoney(value, 'RUB');
  }

  protected cls(value: string | null): string {
    return value === null ? 'pnl-zero' : pnlColorClass(value);
  }
}
