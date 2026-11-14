import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { RouterLink } from '@angular/router';
import type { InstrumentType, Position, SettlementCheckDto, QuoteRefreshResult } from '@core';
import { firstValueFrom } from 'rxjs';
import Decimal from 'decimal.js';
import { OperationApi } from '../../entities/operation/operation.api';
import { PositionApi } from '../../entities/position/position.api';
import { summaryResource, type SummaryFilter } from '../../entities/summary/summary.api';
import { ReferenceApi } from '../../entities/reference/reference.api';
import {
  TYPE_COLOR,
  TYPE_LABEL,
  TYPE_ORDER,
} from '../../entities/instrument/instrument-type.tokens';
import { ManagePortfoliosDialog } from '../../features/manage-portfolios/manage-portfolios.dialog';
import { ManageSystemsDialog } from '../../features/manage-systems/manage-systems.dialog';
import { PossibleDuplicatesCard } from '../../features/possible-duplicates/possible-duplicates.card';
import { MergedIdentifiersCard } from '../../widgets/merged-identifiers/merged-identifiers.card';
import { MergeInstrumentDialog } from '../../features/merge-instrument/merge-instrument.dialog';
import { SetManualPriceDialog } from '../../features/set-manual-price/set-manual-price.dialog';
import { AllocationChart } from '../../widgets/allocation-chart/allocation-chart';
import {
  buildCsv,
  downloadCsv,
  formatMoney,
  formatPrice,
  formatRub,
  formatValuation,
  KpiCard,
  pnlColorClass,
  slugForFilename,
  StateMessage,
  ToastService,
  toneOf,
  type CsvColumn,
} from '@web-shared';
import { toIsoDate } from '../../shared/iso-date';

/**
 * Страница «Портфель» (docs/03-ux-plan.md, шаг 3; roadmap Фаза 2).
 * Позиции из API (движок @core на бэке), текущие цены — из котировок (MOEX/ЦБ).
 * Группировка по типам инструментов, фильтр по системе/портфелю, круговая
 * диаграмма распределения текущей стоимости.
 */

interface Row {
  /** Сверка с вариационной маржой брокера — только у фьючерсов с импортированным отчётом */
  settlementCheck: SettlementCheckDto | null;
  instrumentId: string;
  ticker: string;
  type: InstrumentType;
  currency: string;
  qty: string;
  avg: string;
  /** Средняя цена покупки без форматирования — стартовое значение для ручной цены */
  avgRaw: string;
  avgPriceCurrency: string;
  priceCurrency: string | null;
  realized: string;
  unrealized: string;
  payouts: string;
  current: string;
  currentRaw: string | null;
  manual: boolean;
  context: string;
  freshness: string | null;
  /** Накопленный купонный доход по всему остатку, «—» для не-облигаций */
  accrued: string;
  value: string;
  valuationIssue: string | null;
  pnl: string;
  pnlClass: string;
  /**
   * Открытый остаток (qty ≠ 0), для которого не нашлось текущей цены — единственный
   * точно вычислимый признак «похоже на дубль-инструмент из импорта» (см.
   * TMON@/TMON, TCS00A10B4K3/RU000A10B4K3): угадывать дубль по совпадению
   * тикера/названия ненадёжно — у обоих реальных случаев они не совпадали вовсе,
   * а вот «держим остаток, но цены для него в принципе нет» — ровно то, что
   * ломает P&L и что видит пользователь. Кнопку слияния показываем только тут,
   * а не на каждой строке — иначе она не говорит ничего о том, что стоит трогать.
   */
  suspicious: boolean;
}
const COLUMNS = ['ticker', 'qty', 'avg', 'current', 'value', 'pnl', 'actions'];
/** У облигаций между ценой и стоимостью встаёт НКД — иначе «стоимость ≠ цена × кол-во» */
const COLUMNS_WITH_ACCRUED = [
  'ticker',
  'qty',
  'avg',
  'current',
  'accrued',
  'value',
  'pnl',
  'actions',
];

/**
 * decimal-строка бэка → число для ячейки CSV. Именно число, а не строка: числовая
 * ячейка складывается и фильтруется в Excel, текстовая — нет. Точность не режем —
 * количество бывает дробным на восемь знаков (криптовалюта).
 */
const csvNumber = (value: string | null): number | null => (value === null ? null : Number(value));

/**
 * То же для денег, но с округлением до копеек: без `toFixed` в ячейку уезжает
 * хвост двоичной дроби (12,340000000000001).
 */
const csvMoney = (value: string | null): number | null =>
  value === null ? null : Number(Number(value).toFixed(2));

interface Group {
  type: InstrumentType;
  label: string;
  rows: Row[];
  valueRub: number | null;
  unvaluedPositionCount: number;
  /** Колонки таблицы группы: НКД показываем только там, где он вообще есть (облигации) */
  columns: string[];
}

@Component({
  selector: 'app-portfolio-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatCardModule,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatSelectModule,
    MatTooltipModule,
    RouterLink,
    KpiCard,
    StateMessage,
    AllocationChart,
    PossibleDuplicatesCard,
    MergedIdentifiersCard,
  ],
  template: `
    <div class="header">
      <h1 class="page-title">Портфель</h1>
      <div class="actions">
        <button mat-stroked-button (click)="managePortfolios()">
          <mat-icon>account_balance</mat-icon>
          Портфели
        </button>
        <button mat-stroked-button (click)="manageSystems()">
          <mat-icon>category</mat-icon>
          Системы
        </button>
        <button mat-stroked-button (click)="refresh()" [disabled]="refreshing()">
          <mat-icon>refresh</mat-icon>
          {{ refreshing() ? 'Обновление…' : 'Обновить цены' }}
        </button>
        <button
          mat-stroked-button
          (click)="exportCsv()"
          [disabled]="positions().length === 0"
          matTooltip="Выгрузить позиции в CSV — ровно те строки, что показаны сейчас, с учётом фильтров системы и портфеля."
        >
          <mat-icon>download</mat-icon>
          Экспорт CSV
        </button>
      </div>
    </div>

    <div class="filters">
      <mat-form-field appearance="outline">
        <mat-label>Система</mat-label>
        <mat-select [value]="systemFilter()" (valueChange)="systemFilter.set($event)">
          <mat-option [value]="null">Все системы</mat-option>
          @for (s of systemOptions(); track s.id) {
            <mat-option [value]="s.id">{{ s.name }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Портфель</mat-label>
        <mat-select [value]="portfolioFilter()" (valueChange)="portfolioFilter.set($event)">
          <mat-option [value]="null">Все портфели</mat-option>
          @for (p of portfolioOptions(); track p.id) {
            <mat-option [value]="p.id">{{ p.name }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <!-- Статистика есть только у конкретной системы; текущий портфель едет в query -->
      @if (systemFilter(); as systemId) {
        <a
          mat-stroked-button
          [routerLink]="['/systems', systemId]"
          [queryParams]="portfolioFilter() ? { portfolio: portfolioFilter() } : null"
        >
          <mat-icon>query_stats</mat-icon>
          Статистика системы
        </a>
      }
    </div>

    @if (refreshError()) {
      <p role="alert">Не удалось обновить котировки. Повторите попытку.</p>
    }
    @if (refreshResult(); as result) {
      <div class="refresh-result" role="status">
        <p>{{ refreshMessage() }} · Пропущено ручных: {{ result.skippedManual }}</p>
        @if (result.failures.length) {
          <details>
            <summary>Не удалось обновить: {{ result.failures.length }}</summary>
            <ul>
              @for (failure of result.failures; track $index) {
                <li>{{ failure.ticker }} · {{ failure.source }} — {{ failure.reason }}</li>
              }
            </ul>
          </details>
        }
      </div>
    }
    <app-possible-duplicates />
    <app-merged-identifiers />

    @if (summary.error()) {
      <app-state-message
        kind="error"
        title="Не удалось загрузить сводку"
        retryLabel="Повторить"
        (retry)="summary.reload()"
      />
    } @else if (summary.hasValue()) {
      <div class="kpi-grid">
        <app-kpi-card label="Вложено (₽)" [value]="investedTotal()" />
        <app-kpi-card label="Текущая стоимость (₽)" [value]="valueTotal()" />
        <app-kpi-card
          label="Получено дивидендов/купонов (₽)"
          [value]="dividendsTotal()"
          [hint]="dividendsHint"
        />
        <app-kpi-card label="P&L (₽)" [value]="pnlTotal()" [tone]="pnlTone()" [hint]="pnlHint" />
      </div>
    } @else {
      <p role="status">Загрузка сводки…</p>
    }

    @if (positionApi.positions.error()) {
      <app-state-message
        kind="error"
        title="Не удалось загрузить позиции"
        hint="Проверьте, что сервер запущен, и попробуйте ещё раз."
        retryLabel="Повторить"
        (retry)="positionApi.positions.reload()"
      />
      <!-- hasValue(), а не !isLoading(): «Обновить цены» перезапрашивает позиции, и
           на !isLoading() таблицы с диаграммой пропадали на время запроса -->
    } @else if (positionApi.positions.hasValue() && groups().length === 0) {
      <mat-card>
        @if (allPositions().length === 0) {
          <app-state-message
            kind="empty"
            title="Позиций пока нет"
            hint="Добавьте операции на странице «Операции» или загрузите отчёт брокера на странице «Импорт»."
          />
        } @else {
          <app-state-message
            kind="empty"
            icon="filter_alt_off"
            title="Нет позиций под выбранные фильтры"
            hint="Сбросьте фильтры, чтобы увидеть остальные позиции."
          />
          <button mat-stroked-button (click)="resetFilters()">Сбросить фильтры</button>
        }
      </mat-card>
    } @else if (positionApi.positions.hasValue()) {
      <div class="content">
        <div class="tables">
          @for (g of groups(); track g.type) {
            <mat-card class="group">
              <div class="group-head">
                <h3>{{ g.label }}</h3>
                <span class="group-total">{{
                  valuation(g.valueRub, g.unvaluedPositionCount)
                }}</span>
              </div>
              @if (g.type === 'Future') {
                <p class="group-note">
                  Цены — в ₽ за контракт. Количество со знаком: минус — короткая позиция (шорт).
                  «Стоимость» — нереализованный результат по расчётной цене: вложений у фьючерса
                  нет. Процентов на «вложено» у фьючерсов нет: их результат входит в рублёвый
                  результат портфеля.
                </p>
              }
              <div
                class="table-scroll"
                role="region"
                [attr.aria-label]="g.label + ': позиции'"
                tabindex="0"
              >
                <table mat-table [dataSource]="g.rows">
                  <ng-container matColumnDef="ticker">
                    <th mat-header-cell *matHeaderCellDef>Тикер</th>
                    <td mat-cell *matCellDef="let r">
                      {{ r.ticker }}
                      <small class="position-context">{{ r.context }}</small>
                      @if (r.settlementCheck; as sc) {
                        <mat-icon
                          class="settlement settlement--{{ sc.status }}"
                          [matTooltip]="settlementTooltip(sc)"
                          [attr.aria-label]="settlementTooltip(sc)"
                          >{{
                            sc.status === 'ok'
                              ? 'verified'
                              : sc.status === 'mismatch'
                                ? 'warning'
                                : 'help_outline'
                          }}</mat-icon
                        >
                      }
                    </td>
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
                    <td mat-cell *matCellDef="let r">
                      {{ r.current }}
                      @if (r.freshness) {
                        <small class="freshness">{{ r.freshness }}</small>
                      }
                    </td>
                  </ng-container>
                  <ng-container matColumnDef="accrued">
                    <th
                      mat-header-cell
                      *matHeaderCellDef
                      matTooltip="Накопленный купонный доход по всему остатку. Биржа котирует облигации без него, а при продаже его платит покупатель — поэтому он входит в «Стоимость», как и у брокера."
                    >
                      НКД (₽)
                    </th>
                    <td mat-cell *matCellDef="let r">{{ r.accrued }}</td>
                  </ng-container>
                  <ng-container matColumnDef="value">
                    <th mat-header-cell *matHeaderCellDef>Стоимость (₽)</th>
                    <td mat-cell *matCellDef="let r">
                      {{ r.value }}
                      @if (r.valuationIssue) {
                        <small>{{ r.valuationIssue }}</small>
                      }
                    </td>
                  </ng-container>
                  <ng-container matColumnDef="pnl">
                    <th mat-header-cell *matHeaderCellDef>P&L (₽)</th>
                    <td mat-cell *matCellDef="let r" [class]="r.pnlClass">
                      <details class="pnl-details">
                        <summary [attr.aria-label]="'Состав P&L: ' + r.ticker + ', ' + r.context">{{ r.pnl }}</summary>
                        <dl>
                          <dt>Реализованный результат</dt><dd>{{ r.realized }}</dd>
                          <dt>Нереализованный результат</dt><dd>{{ r.unrealized }}</dd>
                          <dt>Дивиденды и купоны</dt><dd>{{ r.payouts }}</dd>
                        </dl>
                      </details>
                    </td>
                  </ng-container>
                  <ng-container matColumnDef="actions">
                    <th mat-header-cell *matHeaderCellDef></th>
                    <td mat-cell *matCellDef="let r">
                      @if (r.suspicious) {
                        @if (r.type !== 'Future') {
                          <button
                            mat-icon-button
                            (click)="resolvePrice(r)"
                            aria-label="Найти цену на бирже"
                            matTooltip="Проверить, не торгуется ли этот инструмент на MOEX/Binance под тем же тикером — импорт из отчёта заводит новые бумаги без автоисточника цены, даже когда биржа их знает."
                          >
                            <mat-icon>travel_explore</mat-icon>
                          </button>
                        }
                        <button
                          mat-icon-button
                          (click)="mergeInstrument(r)"
                          aria-label="Объединить с другим инструментом"
                          matTooltip="Если это дубль другого инструмента из вашего портфеля (брокерский импорт иногда заводит одну бумагу дважды под разными кодами) — объедините их."
                        >
                          <mat-icon>call_merge</mat-icon>
                        </button>
                      }
                      @if (r.manual) {
                        <button
                          mat-icon-button
                          (click)="setManualPrice(r)"
                          [attr.aria-label]="
                            r.currentRaw === null ? 'Указать цену' : 'Изменить цену'
                          "
                          [matTooltip]="r.currentRaw === null ? 'Указать цену' : 'Изменить цену'"
                        >
                          <mat-icon>edit</mat-icon>
                        </button>
                      }
                    </td>
                  </ng-container>
                  <tr mat-header-row *matHeaderRowDef="g.columns"></tr>
                  <tr mat-row *matRowDef="let row; columns: g.columns"></tr>
                </table>
              </div>
            </mat-card>
          }
        </div>

        <!-- @defer: диаграмма живёт в правой колонке и на узком экране уезжает под
             таблицы — грузить chart.js до того, как до неё долистают, незачем -->
        @defer (on viewport) {
          <app-allocation-chart title="Распределение по типам" [slices]="allocation()" [emptyTitle]="allocationEmptyTitle()" />
        } @placeholder {
          <div class="chart-box"></div>
        }
      </div>
    } @else {
      <p role="status">Загрузка позиций…</p>
    }
  `,
  styles: [
    `
      /* индикатор сверки с вариационной маржой брокера у фьючерса */
      .settlement {
        width: 18px;
        height: 18px;
        font-size: 18px;
        vertical-align: middle;
        margin-left: 4px;
        cursor: help;
      }
      .settlement--ok {
        color: var(--app-success, #199e70);
      }
      .settlement--mismatch {
        color: var(--app-danger, #e34948);
      }
      .settlement--unknown {
        color: var(--app-text-muted);
      }
      :host {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        min-width: 0;
        max-width: 100%;
      }
      .header {
        flex: 0 0 auto;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      /* .filters — глобальный (styles.scss) */
      .filters {
        flex: 0 0 auto;
        margin: 8px 0 0;
        flex-wrap: wrap;
        min-width: 0;
      }
      .filters mat-form-field {
        min-width: 0;
        max-width: 100%;
      }
      .refresh-result {
        overflow-wrap: anywhere;
      }
      .refresh-result p {
        margin: 8px 0;
      }
      /* .kpi-grid — глобальный (styles.scss); здесь только «не растягиваться» */
      .kpi-grid {
        flex: 0 0 auto;
      }
      /*
       * Mobile-first: на узком экране таблицы и диаграмма идут друг под другом.
       * Единственный настоящий медиазапрос во всём приложении — соотношение 2fr/1fr
       * надо СОХРАНИТЬ на широких экранах, а auto-fit этого выразить не может.
       */
      .content {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 16px;
        align-items: start;
        flex: 0 0 auto;
        min-width: 0;
      }
      @media (min-width: 960px) {
        .content {
          grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
        }
      }
      .tables {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .group {
        min-width: 0;
        padding: 8px 8px 0;
      }
      .group-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 8px;
        overflow-wrap: anywhere;
        padding: 8px 8px 0;
      }
      .group-head h3 {
        margin: 0;
        font-weight: 500;
      }
      .group-total {
        color: var(--app-text-muted);
      }
      .group-note {
        margin: 4px 8px 0;
        font-size: 12px;
        color: var(--app-text-muted);
      }
      .pnl-details summary { cursor: pointer; }
      .pnl-details dl { font-size: 12px; color: var(--app-text-muted); }
      .pnl-details dd { margin: 0 0 6px; }
      .table-scroll {
        max-width: 100%;
        overflow-x: auto;
      }
      table {
        width: 100%;
        min-width: 840px;
      }
      th,
      td {
        white-space: nowrap;
      }
      .position-context,
      .freshness {
        display: block;
        white-space: normal;
        overflow-wrap: anywhere;
        color: var(--app-text-muted);
        font-size: 12px;
        line-height: 1.4;
      }
      .position-context {
        width: 180px;
      }
      .freshness {
        width: 145px;
      }
      td small {
        display: block;
        white-space: normal;
        max-width: 200px;
      }
      /* .chart-box и .error — глобальные (styles.scss) */
    `,
  ],
})
export class PortfolioPage {
  protected readonly api = inject(OperationApi);
  protected readonly positionApi = inject(PositionApi);
  private readonly reference = inject(ReferenceApi);
  private readonly dialog = inject(MatDialog);
  private readonly toast = inject(ToastService);

  protected readonly refreshing = signal(false);
  protected readonly refreshError = signal(false);
  protected readonly refreshResult = signal<QuoteRefreshResult | null>(null);
  protected readonly refreshMessage = computed(() => {
    const result = this.refreshResult();
    if (!result) return '';
    if (result.total === 0) return 'Нет инструментов для автообновления';
    if (result.updated === 0) return `Не получено ни одной цены из ${result.total}`;
    if (result.updated === result.total)
      return `Котировки обновлены: ${result.updated} из ${result.total}`;
    return `Обновлено ${result.updated} из ${result.total}`;
  });

  protected resetFilters(): void {
    this.systemFilter.set(null);
    this.portfolioFilter.set(null);
  }

  /**
   * «Тек. цена» раньше показывала значение с последнего клика «Обновить цены» —
   * могло быть старым, если давно не нажимали. При каждом открытии страницы тихо
   * освежаем котировки сами. Результат попытки показываем отдельно; при отказе
   * провайдера остаются прежние цена и дата получения.
   */
  constructor() {
    void this.refresh();
  }

  /**
   * Дивиденды/купоны — это уже полученный кэш, не переоценка позиции, поэтому
   * не входят в «Текущую стоимость» (она — рыночная цена держимых бумаг), но
   * входят в P&L. Без этой карточки разница между «Вложено/Текущая» и P&L
   * выглядит как «пропавшие деньги» — реальный вопрос пользователя.
   */
  protected readonly dividendsHint =
    'Дивиденды и купоны, уже выплаченные вам, — это кэш, не переоценка бумаги. ' +
    'Они не входят в «Текущую стоимость» (там только рыночная цена держимых позиций), ' +
    'но входят в P&L. Поэтому P&L может быть положительным, даже если рынок просел.';

  /**
   * P&L = реализ. + нереализ. + дивиденды — включает результат по уже закрытым
   * (проданным) позициям, а не только по текущему остатку. «Вложено − Стоимость −
   * Дивиденды» даст другое число — оно молча теряет уже зафиксированную прибыль/убыток.
   */
  protected readonly pnlHint =
    'P&L = реализ. + нереализ. + дивиденды/купоны. Реализ. — результат по уже ' +
    'закрытым (проданным) позициям, эти деньги уже ваши независимо от того, ' +
    'вывели вы их или реинвестировали. «Вложено − Стоимость − Дивиденды» даст ' +
    'другое число — оно молча теряет эту уже зафиксированную прибыль/убыток.';

  protected readonly systemFilter = signal<string | null>(null);
  protected readonly portfolioFilter = signal<string | null>(null);

  /**
   * Фильтр сводки страницы: итоговые карточки берут те же отфильтрованные totals(),
   * что и таблица «Эффективность» на дашборде. Период здесь не задаётся — карточки
   * описывают состояние на сегодня.
   *
   * Раньше это писалось эффектом в общий на всё приложение
   * `OperationApi.summaryFilter`, и фильтр «Портфеля» (без дат) затирал период,
   * выбранный на дашборде, а вход на страницу стоил лишнего запроса.
   */
  private readonly summaryFilter = computed<SummaryFilter>(() => ({
    systemId: this.systemFilter() ?? undefined,
    portfolioId: this.portfolioFilter() ?? undefined,
  }));

  protected readonly summary = summaryResource(this.summaryFilter);

  /** Все позиции из API */
  protected readonly allPositions = computed(() =>
    this.positionApi.positions.hasValue() ? this.positionApi.positions.value() : [],
  );

  /** Позиции после применения фильтров по системе/портфелю */
  protected readonly positions = computed(() => {
    const sys = this.systemFilter();
    const port = this.portfolioFilter();
    return this.allPositions().filter(
      (p) => (sys === null || p.systemId === sys) && (port === null || p.portfolioId === port),
    );
  });

  /**
   * Справочники «id → название». Нужны и опциям фильтров, и выгрузке в CSV
   * (в файле система с портфелем читаются человеком, id там бесполезен).
   */
  private readonly systemNames = computed(
    () =>
      new Map(
        (this.reference.systems.hasValue() ? this.reference.systems.value() : []).map((s) => [
          s.id,
          s.name,
        ]),
      ),
  );

  private readonly portfolioNames = computed(
    () =>
      new Map(
        (this.reference.portfolios.hasValue() ? this.reference.portfolios.value() : []).map((p) => [
          p.id,
          p.name,
        ]),
      ),
  );

  /** Опции фильтров — только системы/портфели, которые реально встречаются в позициях */
  protected readonly systemOptions = computed(() => {
    const names = this.systemNames();
    const ids = [...new Set(this.allPositions().map((p) => p.systemId))];
    return ids.map((id) => ({ id, name: names.get(id) ?? id }));
  });

  /** Подсказка индикатора сверки: сверено / расхождение N ₽ / не удалось сверить */
  protected settlementTooltip(sc: SettlementCheckDto): string {
    if (sc.status === 'ok') return `Сверено с брокером (вариационная маржа, отчёт на ${sc.asOf})`;
    if (sc.status === 'mismatch') {
      return `Расхождение с брокером ${formatMoney(sc.diffRub ?? '0', 'RUB')}: результат по журналу ${formatMoney(sc.engineRub ?? '0', 'RUB')}, вариационная маржа отчёта на ${sc.asOf} — ${formatMoney(sc.brokerRub, 'RUB')}. Проверьте, что импортированы все сделки.`;
    }
    return `Сверить не удалось: ${sc.reason ?? 'нет данных'}`;
  }

  protected readonly portfolioOptions = computed(() => {
    const names = this.portfolioNames();
    const ids = [...new Set(this.allPositions().map((p) => p.portfolioId))];
    return ids.map((id) => ({ id, name: names.get(id) ?? id }));
  });

  /** Позиции, сгруппированные по типу инструмента (с подытогом стоимости) */
  protected readonly groups = computed<Group[]>(() => {
    const byType = new Map<InstrumentType, Row[]>();
    const valueByType = new Map<InstrumentType, number>();
    const missingByType = new Map<InstrumentType, number>();
    const valuedByType = new Map<InstrumentType, number>();

    for (const p of this.positions()) {
      const rows = byType.get(p.type) ?? [];
      rows.push({
        instrumentId: p.instrumentId,
        ticker: p.ticker,
        settlementCheck: p.settlementCheck,
        type: p.type,
        currency: p.currency,
        qty: p.quantity,
        // средняя — в валюте СДЕЛОК, текущая цена — в валюте КОТИРОВКИ: у замещающих
        // облигаций это разные валюты (покупка за рубли, номинал в долларах), и
        // подписывать обе валютой инструмента значило показывать рубли со знаком $
        avg: formatPrice(p.avgBuyPrice, p.avgPriceCurrency),
        avgRaw: p.avgBuyPrice,
        avgPriceCurrency: p.avgPriceCurrency,
        priceCurrency: p.priceCurrency,
        realized: formatMoney(p.realizedPnlRub),
        unrealized: formatMoney(p.unrealizedPnlRub),
        payouts: formatMoney(new Decimal(p.dividendsRub).plus(p.couponsRub).toFixed(2)),
        manual: p.marketSource === 'manual',
        currentRaw: p.currentPrice,
        context: `${this.systemNames().get(p.systemId) ?? p.systemId} · ${this.portfolioNames().get(p.portfolioId) ?? p.portfolioId}`,
        freshness: p.priceSource === 'broker-report' && p.quoteDate
          ? `Цена по отчёту за ${p.quoteDate}`
          : p.priceAsOf
          ? `${p.priceSource === 'manual' ? 'Введено' : 'Получено'} ${new Date(p.priceAsOf).toLocaleString('ru-RU')}`
          : p.quoteDate
            ? `Котировка за ${p.quoteDate}`
            : null,
        current: p.currentPrice ? formatPrice(p.currentPrice, p.priceCurrency ?? p.currency) : '—',
        accrued: p.accruedInterestRub ? formatMoney(p.accruedInterestRub, 'RUB') : '—',
        value: formatMoney(p.currentValueRub, 'RUB'),
        valuationIssue: p.valuationIssue,
        pnl: p.pnlRub ? formatMoney(p.pnlRub, 'RUB') : '—',
        pnlClass: p.pnlRub ? pnlColorClass(p.pnlRub) : 'pnl-zero',
        suspicious: p.currentPrice === null && Number(p.quantity) !== 0,
      });
      byType.set(p.type, rows);
      if (Number(p.quantity) !== 0) {
        if (p.currentValueRub === null) {
          missingByType.set(p.type, (missingByType.get(p.type) ?? 0) + 1);
        } else {
          valuedByType.set(p.type, (valuedByType.get(p.type) ?? 0) + 1);
          valueByType.set(p.type, (valueByType.get(p.type) ?? 0) + Number(p.currentValueRub));
        }
      }
    }

    return TYPE_ORDER.filter((t) => byType.has(t)).map((t) => {
      const rows = byType.get(t) ?? [];
      return {
        type: t,
        label: TYPE_LABEL[t],
        rows,
        valueRub:
          (missingByType.get(t) ?? 0) > 0 && !valuedByType.has(t)
            ? null
            : (valueByType.get(t) ?? 0),
        unvaluedPositionCount: missingByType.get(t) ?? 0,
        // колонку НКД показываем, только если он реально есть хоть у одной бумаги
        // группы, — по факту данных, а не по типу инструмента
        columns: rows.some((r) => r.accrued !== '—') ? COLUMNS_WITH_ACCRUED : COLUMNS,
      };
    });
  });

  /**
   * Доли распределения для круговой диаграммы — цвет закреплён за типом инструмента.
   * Фьючерсы в диаграмму не входят: их «стоимость» — нереализованный результат (может
   * быть отрицательной), а не доля капитала, и сектор круга для неё не имеет смысла.
   */
  protected readonly allocationEmptyTitle = computed(() => {
    const eligible = this.positions().filter((p) => p.type !== 'Future' && Number(p.quantity) !== 0);
    if (eligible.length === 0) return 'Нет активов для распределения';
    if (eligible.some((p) => p.currentValueRub === null)) return 'Оценка активов недоступна';
    return 'Нет положительной стоимости для распределения';
  });

  protected readonly allocation = computed(() =>
    this.groups()
      .filter((g) => g.type !== 'Future' && g.valueRub !== null)
      .map((g) => ({ label: g.label, valueRub: g.valueRub as number, color: TYPE_COLOR[g.type] })),
  );

  /**
   * Итоговые карточки берём из summary().totals (та же формула и тот же фильтр,
   * что у таблицы «Эффективность» на дашборде: P&L = реализ. + нереализ. +
   * дивиденды), а НЕ суммируем построчный pnl текущих позиций — тот считает
   * только открытый остаток и не видит результат по уже закрытым сделкам.
   * Раньше это расходилось с дашбордом ровно на величину реализованного P&L
   * (напр. −84 248,81 ₽ здесь против −45 915,13 ₽ на дашборде для тех же данных).
   */
  private readonly totals = computed(() =>
    this.summary.hasValue() ? this.summary.value().totals : undefined,
  );

  protected readonly investedTotal = computed(() => formatRub(this.totals()?.investedRub));

  protected readonly valueTotal = computed(() =>
    formatValuation(this.totals()?.currentValueRub, this.totals()?.unvaluedPositionCount ?? 0),
  );

  protected readonly pnlTotalRaw = computed(() => this.totals()?.pnlRub ?? null);

  protected readonly pnlTotal = computed(() => formatRub(this.pnlTotalRaw()));

  protected readonly pnlTone = computed(() => toneOf(this.pnlTotalRaw()));

  protected readonly dividendsTotal = computed(() => formatRub(this.totals()?.dividendsRub));

  protected readonly money = formatRub;
  protected readonly valuation = formatValuation;

  /**
   * Позиции для выгрузки в том же порядке, в каком они на экране: сортировка по
   * TYPE_ORDER повторяет порядок групп, а внутри группы `sort` стабилен и
   * сохраняет исходный порядок строк.
   */
  private readonly exportRows = computed(() => {
    const order = new Map(TYPE_ORDER.map((t, i) => [t, i]));
    return [...this.positions()].sort(
      (a, b) => (order.get(a.type) ?? TYPE_ORDER.length) - (order.get(b.type) ?? TYPE_ORDER.length),
    );
  });

  /**
   * Выгрузка текущего состояния портфеля в CSV — те же строки, что на экране,
   * с учётом фильтров системы и портфеля (`positions()`, а не `allPositions()`).
   *
   * Колонок больше, чем в таблице: в файл идут и составляющие P&L (реализованный,
   * дивиденды, купоны), ради которых выгрузку и открывают в Excel. Итоговой
   * строки СОЗНАТЕЛЬНО нет: карточки наверху считают P&L по всей истории, включая
   * уже закрытые позиции, а сумма столбца — только по открытым остаткам, и «итог»
   * в файле расходился бы с «итогом» на экране (см. комментарий к totals()).
   */
  protected exportCsv(): void {
    const rows = this.exportRows();
    const systems = this.systemNames();
    const portfolios = this.portfolioNames();

    const columns: CsvColumn<Position>[] = [
      { header: 'Тип', value: (p) => TYPE_LABEL[p.type] },
      { header: 'Тикер', value: (p) => p.ticker },
      { header: 'Валюта инструмента', value: (p) => p.currency },
      { header: 'Система', value: (p) => systems.get(p.systemId) ?? p.systemId },
      { header: 'Портфель', value: (p) => portfolios.get(p.portfolioId) ?? p.portfolioId },
      { header: 'Количество', value: (p) => csvNumber(p.quantity) },
      { header: 'Средняя цена', value: (p) => csvNumber(p.avgBuyPrice) },
      // валюты выносим отдельными колонками: средняя и текущая цена бывают в разных
      // (замещающие облигации), и без подписи столбцы нельзя интерпретировать
      { header: 'Валюта средней', value: (p) => p.avgPriceCurrency },
      { header: 'Текущая цена', value: (p) => csvNumber(p.currentPrice) },
      { header: 'Валюта цены', value: (p) => p.priceCurrency },
      { header: 'НКД (₽)', value: (p) => csvMoney(p.accruedInterestRub) },
      { header: 'Вложено (₽)', value: (p) => csvMoney(p.investedRub) },
      { header: 'Стоимость (₽)', value: (p) => csvMoney(p.currentValueRub) },
      { header: 'Реализованный P&L (₽)', value: (p) => csvMoney(p.realizedPnlRub) },
      { header: 'Дивиденды (₽)', value: (p) => csvMoney(p.dividendsRub) },
      { header: 'Купоны (₽)', value: (p) => csvMoney(p.couponsRub) },
      { header: 'P&L (₽)', value: (p) => csvMoney(p.pnlRub) },
    ];

    downloadCsv(this.exportFilename(), buildCsv(rows, columns));
    this.toast.success(`Выгружено позиций: ${rows.length}`);
  }

  /**
   * Имя файла говорит, что именно внутри: активные фильтры попадают в него, иначе
   * несколько выгрузок за день различались бы только порядком скачивания.
   */
  private exportFilename(): string {
    const parts = ['portfolio'];
    const system = this.systemFilter();
    if (system) parts.push(slugForFilename(this.systemNames().get(system) ?? system));
    const portfolio = this.portfolioFilter();
    if (portfolio) parts.push(slugForFilename(this.portfolioNames().get(portfolio) ?? portfolio));
    parts.push(toIsoDate(new Date()));
    return `${parts.join('-')}.csv`;
  }

  protected managePortfolios(): void {
    this.dialog.open(ManagePortfoliosDialog, {
      autoFocus: false,
      width: '760px',
      maxWidth: '95vw',
    });
  }

  protected manageSystems(): void {
    this.dialog.open(ManageSystemsDialog, { autoFocus: false, width: '760px', maxWidth: '95vw' });
  }

  /**
   * Найти цену через MOEX/Binance (docs: GOLD — БПИФ, который файловый импорт
   * завёл как marketSource='manual' из осторожности, хотя биржа его прекрасно
   * знает под тем же тикером). Основное действие для «подозрительной» строки —
   * дешевле и надёжнее ручного ввода, когда бумага просто не была замечена как
   * биржевая при импорте.
   */
  protected async resolvePrice(row: Row): Promise<void> {
    await this.reference.resolvePrice(row.instrumentId);
  }

  /**
   * Слить дубль-инструмент (docs: TMON@/TMON) — брокерский импорт иногда заводит
   * два инструмента на один реальный актив под разными кодами; распознать и
   * подтвердить может только пользователь (см. MergeInstrumentDialog).
   */
  protected async mergeInstrument(row: Row): Promise<void> {
    const ref = this.dialog.open(MergeInstrumentDialog, {
      autoFocus: false,
      data: { sourceId: row.instrumentId, sourceTicker: row.ticker, type: row.type },
    });
    const result = await firstValueFrom(ref.afterClosed());
    if (!result) return;
    await this.reference.mergeInstruments(
      row.instrumentId,
      result.targetId,
      result.confirmWarnings,
    );
  }

  /**
   * Указать цену вручную — фоллбэк, когда resolvePrice() не находит инструмент ни
   * на одной подключённой площадке (реально внебиржевой актив, а не просто
   * не распознанный при импорте тикер).
   */
  protected async setManualPrice(row: Row): Promise<void> {
    const ref = this.dialog.open(SetManualPriceDialog, {
      autoFocus: false,
      data: {
        ticker: row.ticker,
        currency: row.type === 'Future' ? 'RUB' : row.currency,
        avgPriceCurrency: row.avgPriceCurrency,
        priceCurrency: row.priceCurrency,
        avgBuyPrice: row.avgRaw,
        currentPrice: row.currentRaw,
        perContract: row.type === 'Future',
      },
    });
    const result = await firstValueFrom(ref.afterClosed());
    if (!result) return;
    await this.api.setManualPrice(row.instrumentId, result.price);
  }

  protected async refresh(): Promise<void> {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    this.refreshError.set(false);
    try {
      this.refreshResult.set(await this.api.refreshQuotes());
    } catch {
      this.refreshResult.set(null);
      this.refreshError.set(true);
    } finally {
      this.refreshing.set(false);
    }
  }
}
