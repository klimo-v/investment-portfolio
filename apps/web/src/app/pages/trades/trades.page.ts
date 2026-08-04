import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  type WritableSignal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatTabsModule } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatPaginatorModule, type PageEvent } from '@angular/material/paginator';
import { MatSortModule, type Sort } from '@angular/material/sort';
import { OperationApi } from '../../entities/operation/operation.api';
import { ReferenceApi } from '../../entities/reference/reference.api';
import {
  clampPageIndex,
  formatMoney,
  formatRub,
  KpiCard,
  pageSlice,
  pnlColorClass,
  sortRows,
  StateMessage,
  StatusChip,
  toneOf,
  type ChipTone,
  type SortKey,
  type SortState,
} from '@web-shared';
import { tradeStats, type Trade, type TradeStats, type TradeStatInput } from '@core';

/** Какой из двух списков сделок листаем — у каждого своя страница */
type TradeListKey = 'open' | 'closed';

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
    MatPaginatorModule,
    MatSortModule,
    NgTemplateOutlet,
    KpiCard,
    StateMessage,
    StatusChip,
  ],
  template: `
    <h1 class="page-title">Сделки</h1>

    @if (api.trades.error()) {
      <app-state-message
        kind="error"
        title="Не удалось загрузить сделки"
        hint="Проверьте, что сервер запущен, и попробуйте ещё раз."
        retryLabel="Повторить"
        (retry)="api.reload()"
      />
    } @else if (!api.trades.isLoading()) {
      <!--
        Фильтр портфеля СНАРУЖИ табов и действует на все три, включая «Статистику»
        (раньше статистика его игнорировала). Пока он жил внутри списочного таба,
        асимметрия была незаметна; над общей группой она сбивала бы с толку.
      -->
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

      <mat-tab-group>
        <!--
          Каждому табу — своя страница (key). Один общий pageIndex был бы багом:
          открытых сделок обычно единицы, закрытых сотни, и переключение на «Открытые»
          со страницы 5 показывало бы пустую таблицу.
        -->
        <mat-tab [label]="'Открытые (' + openTrades().length + ')'">
          <ng-container
            [ngTemplateOutlet]="table"
            [ngTemplateOutletContext]="{ rows: pagedOpen(), total: openTrades().length, key: 'open' }"
          />
        </mat-tab>
        <mat-tab [label]="'Закрытые (' + closedTrades().length + ')'">
          <ng-container
            [ngTemplateOutlet]="table"
            [ngTemplateOutletContext]="{
              rows: pagedClosed(),
              total: closedTrades().length,
              key: 'closed',
            }"
          />
        </mat-tab>

        <mat-tab label="Статистика">
          <div class="stats-tab-content">
            @if (overall().closedCount > 0) {
              <mat-card class="stats">
                <div class="stats-head">
                  <h3>Статистика закрытых сделок</h3>
                  <span class="muted">только зафиксированный результат</span>
                </div>
                <div class="kpi-grid">
                  <app-kpi-card label="Сделок" [value]="overall().closedCount.toString()" />
                  <app-kpi-card label="Win rate" [value]="overall().winRatePct.toFixed(0) + '%'" />
                  <app-kpi-card label="Profit factor" [value]="pf(overall().profitFactor)" />
                  <app-kpi-card
                    label="Ср. выигрыш"
                    [value]="money(overall().avgWinRub)"
                    tone="positive"
                  />
                  <app-kpi-card
                    label="Ср. убыток"
                    [value]="money(overall().avgLossRub)"
                    tone="negative"
                  />
                  <app-kpi-card
                    label="Матожидание"
                    [value]="money(overall().expectancyRub)"
                    [tone]="tone(overall().expectancyRub)"
                  />
                  <app-kpi-card
                    label="Ср. срок"
                    [value]="overall().avgHoldingDays.toFixed(0) + ' дн.'"
                  />
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
              <app-state-message
                kind="empty"
                icon="query_stats"
                title="Нет закрытых сделок"
                hint="Win rate, profit factor и матожидание считаются только по зафиксированному результату — закройте хотя бы одну сделку."
              />
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

    <ng-template #table let-rows="rows" let-total="total" let-key="key">
      <mat-card class="table-card">
        @if (total === 0) {
          <app-state-message
            kind="empty"
            title="Сделок нет"
            hint="Сделки собираются из журнала операций автоматически — добавьте покупки и продажи."
          />
        } @else {
        <div class="table-scroll">
          <!--
            matSort у каждого таба свой (состояние — в sortState(key)), как и страница:
            общий на два списка означал бы, что стрелка в заголовке «Закрытых» врёт
            про порядок «Открытых».
          -->
          <table
            mat-table
            matSort
            [matSortActive]="sortState(key).active"
            [matSortDirection]="sortState(key).direction"
            (matSortChange)="onSort(key, $event)"
            [dataSource]="rows"
            multiTemplateDataRows
          >
            <ng-container matColumnDef="status">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Статус</th>
              <td mat-cell *matCellDef="let t">
                <app-status-chip [tone]="statusTone(t.status)">{{ statusLabel(t.status) }}</app-status-chip>
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
              <td mat-cell *matCellDef="let t">{{ formatMoney(t.investedRub, 'RUB') }}</td>
            </ng-container>
            <ng-container matColumnDef="payouts">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Див/купоны (₽)</th>
              <td mat-cell *matCellDef="let t">
                {{ formatMoney(plus(t.dividendsRub, t.couponsRub), 'RUB') }}
              </td>
            </ng-container>
            <ng-container matColumnDef="pnl">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>P&L (₽)</th>
              <td mat-cell *matCellDef="let t" [class]="pnlColorClass(t.pnlRub)">
                {{ formatMoney(t.pnlRub, 'RUB') }}
              </td>
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
                  [attr.aria-label]="(expandedId() === t.id ? 'Скрыть' : 'Показать') + ' операции сделки ' + t.ticker"
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

        <mat-paginator
          [length]="total"
          [pageIndex]="pageIndex(key)"
          [pageSize]="pageSize()"
          [pageSizeOptions]="[25, 50, 100]"
          (page)="onPage(key, $event)"
        ></mat-paginator>
        }
      </mat-card>
    </ng-template>
  `,
  styles: [
    `
      /*
       * Ни :host на всю высоту, ни ::ng-deep. Раньше здесь была цепочка правил,
       * протягивавших height: 100% сквозь ПРИВАТНЫЙ DOM Material
       * (.mat-mdc-tab-body-wrapper/-body/-content) — она существовала только потому,
       * что внутренняя группа табов была обязана заполнить внешнее тело таба.
       * Табы расплющены, тело таба сайзится по содержимому, скроллит страница.
       */
      /* .filters — глобальный (styles.scss) */
      .filters {
        margin-bottom: 12px;
      }
      .stats-tab-content {
        padding-top: 12px;
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
        color: var(--app-text-muted);
      }
      /* .kpi-grid — глобальный (styles.scss) */
      .stats-table {
        width: 100%;
        margin-top: 16px;
      }
      .table-card {
        margin-top: 16px;
      }
      /*
       * Только горизонтальный скролл: вертикальный отдан странице. Внутренний
       * скролл-контейнер был вторым источником цепочки height: 100% выше, а липкий
       * заголовок (sticky: true у matHeaderRowDef) от этого не страдает — он липнет
       * к ближайшему скроллящему предку, которым теперь стал .content из app.ts.
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
      /* .pnl-*, .error — глобальные (styles.scss), локальных копий не держим */
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

  /**
   * Вход для статистики: минимальные поля сделки, реализ. P&L строкой → числом.
   *
   * Фильтр портфеля применяется И ЗДЕСЬ (изменение поведения, 2026-08-04). Раньше
   * статистика считалась по всем сделкам независимо от фильтра — пока фильтр жил
   * внутри списочного таба, это было незаметно. После расплющивания табов он стоит
   * над всеми тремя, и читающий такой макет ждёт «win rate по портфелю X», а не
   * «по всему сразу». Цифры на вкладке «Статистика» при выбранном портфеле теперь
   * отличаются от прежних — это намеренно.
   */
  private readonly statInputs = computed<(TradeStatInput & { systemId: string; portfolioId: string })[]>(
    () =>
      this.trades().map((t) => ({
        systemId: t.systemId,
        portfolioId: t.portfolioId,
        status: t.status,
        realizedPnlRub: Number(t.realizedPnlRub),
        openedAt: t.openedAt,
        closedAt: t.closedAt,
      })),
  );

  /** Статистика по закрытым сделкам выбранного среза */
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

  /** Profit factor или «—», когда убыточных сделок не было и делить не на что */
  protected pf(value: number | null): string {
    return value === null ? '—' : value.toFixed(2);
  }

  protected readonly money = formatRub;
  protected readonly tone = toneOf;

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

  /** Фильтр по портфелю — сужает и списки сделок, и статистику (см. statInputs) */
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

  /**
   * Сортировка списков. Состояние у каждого таба своё — общее означало бы, что
   * стрелка в заголовке одной таблицы описывает порядок другой.
   *
   * По умолчанию — по дате открытия, свежие сверху. Раньше порядок задавал движок
   * (@core: calculateTrades отдаёт сначала закрытые в порядке закрытия, потом
   * открытые в порядке первой покупки) — то есть был осмысленным внутри движка и
   * произвольным для читателя.
   */
  private static readonly DEFAULT_SORT: SortState = { active: 'dates', direction: 'desc' };
  private readonly openSort = signal<SortState>(TradesPage.DEFAULT_SORT);
  private readonly closedSort = signal<SortState>(TradesPage.DEFAULT_SORT);

  protected sortState(key: TradeListKey): SortState {
    return key === 'open' ? this.openSort() : this.closedSort();
  }

  protected onSort(key: TradeListKey, sort: Sort): void {
    (key === 'open' ? this.openSort : this.closedSort).set(sort);
  }

  /**
   * Ключ сортировки колонки. Две колонки показывают ПАРУ значений — сортируем по
   * первому (тому, что читатель видит слева), вторым разрешаем ничью:
   * «Открыта / Закрыта» и «остаток / куплено». У закрытых сделок остаток всегда 0,
   * поэтому «Кол-во» там де-факто сортируется по купленному количеству — что и нужно.
   *
   * `pnlRub` приходит nullable (нет текущей цены → «—» в ячейке): отдаём null, и
   * такие строки уезжают вниз при любом направлении (см. sorting.ts).
   */
  private static readonly STATUS_RANK: Record<Trade['status'], number> = {
    Open: 0,
    Partial: 1,
    Closed: 2,
  };

  private tradeSortKey(t: Trade, column: string): SortKey {
    switch (column) {
      case 'status':
        return TradesPage.STATUS_RANK[t.status];
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

  private readonly sortedOpen = computed(() =>
    sortRows(this.openTrades(), this.openSort(), (t, c) => this.tradeSortKey(t, c)),
  );
  private readonly sortedClosed = computed(() =>
    sortRows(this.closedTrades(), this.closedSort(), (t, c) => this.tradeSortKey(t, c)),
  );

  /**
   * Пагинация списков сделок. Страница у каждого таба своя, размер — общий:
   * закрытых сделок обычно на порядок больше открытых, и один общий pageIndex
   * оставлял бы «Открытые» пустыми после листания «Закрытых».
   *
   * Резать на клиенте, а не на сервере, — сознательно: сделки не хранятся, их
   * целиком пересобирает движок (@core: calculateTrades) из всей истории операций,
   * частями эту выборку не отдать. Пагинация здесь — про то, сколько DOM-строк
   * рендерить, а не про объём запроса.
   */
  private readonly openPage = signal(0);
  private readonly closedPage = signal(0);
  protected readonly pageSize = signal(25);

  protected pageIndex(key: TradeListKey): number {
    return key === 'open' ? this.openPage() : this.closedPage();
  }

  protected onPage(key: TradeListKey, event: PageEvent): void {
    (key === 'open' ? this.openPage : this.closedPage).set(event.pageIndex);
    this.pageSize.set(event.pageSize);
  }

  protected readonly pagedOpen = computed(() =>
    pageSlice(this.sortedOpen(), this.openPage(), this.pageSize()),
  );
  protected readonly pagedClosed = computed(() =>
    pageSlice(this.sortedClosed(), this.closedPage(), this.pageSize()),
  );

  /**
   * Сам pageSlice() индекс уже подрезает, но привязка [pageIndex] у MatPaginator
   * читает сигнал напрямую — без этого эффекта таблица показывала бы первую
   * страницу, а paginator продолжал утверждать «страница 3 из 1».
   */
  private readonly clampPages = effect(() => {
    const size = this.pageSize();
    const fit = (total: number, page: WritableSignal<number>): void => {
      const fixed = clampPageIndex(page(), total, size);
      if (fixed !== page()) page.set(fixed);
    };
    fit(this.openTrades().length, this.openPage);
    fit(this.closedTrades().length, this.closedPage);
  });

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

  protected statusTone(status: Trade['status']): ChipTone {
    return ({ Open: 'info', Partial: 'warn', Closed: 'neutral' } as const)[status];
  }

  protected plus(a: string, b: string): string {
    return (Number(a) + Number(b)).toFixed(2);
  }

  protected readonly formatMoney = formatMoney;
  protected readonly pnlColorClass = pnlColorClass;
}
