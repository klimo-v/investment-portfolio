import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import type { InstrumentType, Position } from '@core';
import { firstValueFrom } from 'rxjs';
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
import { MergeInstrumentDialog } from '../../features/merge-instrument/merge-instrument.dialog';
import { SetManualPriceDialog } from '../../features/set-manual-price/set-manual-price.dialog';
import { AllocationChart } from '../../widgets/allocation-chart/allocation-chart';
import {
  buildCsv,
  downloadCsv,
  formatMoney,
  formatRub,
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
  instrumentId: string;
  ticker: string;
  type: InstrumentType;
  currency: string;
  qty: string;
  avg: string;
  /** Средняя цена покупки без форматирования — стартовое значение для ручной цены */
  avgRaw: string;
  current: string;
  value: string;
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
  valueRub: number;
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
    KpiCard,
    StateMessage,
    AllocationChart,
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
    </div>

    <div class="kpi-grid">
      <app-kpi-card label="Вложено (₽)" [value]="investedTotal()" />
      <app-kpi-card label="Текущая стоимость (₽)" [value]="valueTotal()" />
      <app-kpi-card
        label="Получено дивидендов/купонов (₽)"
        [value]="dividendsTotal()"
        [hint]="dividendsHint"
      />
      <app-kpi-card
        label="P&L (₽)"
        [value]="pnlTotal()"
        [tone]="pnlTone()"
        [hint]="pnlHint"
      />
    </div>

    @if (positionApi.positions.error()) {
      <app-state-message
        kind="error"
        title="Не удалось загрузить позиции"
        hint="Проверьте, что сервер запущен, и попробуйте ещё раз."
        retryLabel="Повторить"
        (retry)="api.reload()"
      />
      <!-- hasValue(), а не !isLoading(): «Обновить цены» перезапрашивает позиции, и
           на !isLoading() таблицы с диаграммой пропадали на время запроса -->
    } @else if (positionApi.positions.hasValue() && groups().length === 0) {
      <mat-card>
        @if (positions().length === 0) {
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
            hint="Сбросьте фильтр системы или портфеля, чтобы увидеть остальные позиции."
          />
        }
      </mat-card>
    } @else if (positionApi.positions.hasValue()) {
      <div class="content">
        <div class="tables">
          @for (g of groups(); track g.type) {
            <mat-card class="group">
              <div class="group-head">
                <h3>{{ g.label }}</h3>
                <span class="group-total">{{ money(g.valueRub) }}</span>
              </div>
              <table mat-table [dataSource]="g.rows">
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
                <ng-container matColumnDef="actions">
                  <th mat-header-cell *matHeaderCellDef></th>
                  <td mat-cell *matCellDef="let r">
                    @if (r.suspicious) {
                      <button
                        mat-icon-button
                        (click)="resolvePrice(r)"
                        aria-label="Найти цену на бирже"
                        matTooltip="Проверить, не торгуется ли этот инструмент на MOEX/Binance под тем же тикером — импорт из отчёта заводит новые бумаги без автоисточника цены, даже когда биржа их знает."
                      >
                        <mat-icon>travel_explore</mat-icon>
                      </button>
                      <button
                        mat-icon-button
                        (click)="setManualPrice(r)"
                        aria-label="Указать цену вручную"
                        matTooltip="Если на бирже её не найти (внебиржевой актив) — введите цену сами."
                      >
                        <mat-icon>edit</mat-icon>
                      </button>
                      <button
                        mat-icon-button
                        (click)="mergeInstrument(r)"
                        aria-label="Объединить с другим инструментом"
                        matTooltip="Если это дубль другого инструмента из вашего портфеля (брокерский импорт иногда заводит одну бумагу дважды под разными кодами) — объедините их."
                      >
                        <mat-icon>call_merge</mat-icon>
                      </button>
                    }
                  </td>
                </ng-container>
                <tr mat-header-row *matHeaderRowDef="columns"></tr>
                <tr mat-row *matRowDef="let row; columns: columns"></tr>
              </table>
            </mat-card>
          }
        </div>

        <!-- @defer: диаграмма живёт в правой колонке и на узком экране уезжает под
             таблицы — грузить chart.js до того, как до неё долистают, незачем -->
        @defer (on viewport) {
          <app-allocation-chart title="Распределение по типам" [slices]="allocation()" />
        } @placeholder {
          <div class="chart-box"></div>
        }
      </div>
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
      /* .filters — глобальный (styles.scss) */
      .filters {
        flex: 0 0 auto;
        margin: 8px 0 0;
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
        grid-template-columns: 1fr;
        gap: 16px;
        align-items: start;
        flex: 1;
        min-height: 0;
        overflow: auto;
      }
      @media (min-width: 960px) {
        .content {
          grid-template-columns: 2fr 1fr;
        }
      }
      .tables {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .group {
        padding: 8px 8px 0;
      }
      .group-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        padding: 8px 8px 0;
      }
      .group-head h3 {
        margin: 0;
        font-weight: 500;
      }
      .group-total {
        color: var(--app-text-muted);
      }
      table {
        width: 100%;
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

  protected readonly columns = ['ticker', 'qty', 'avg', 'current', 'value', 'pnl', 'actions'];
  protected readonly refreshing = signal(false);

  /**
   * «Тек. цена» раньше показывала значение с последнего клика «Обновить цены» —
   * могло быть старым, если давно не нажимали. При каждом открытии страницы тихо
   * освежаем котировки сами; если провайдер недоступен для инструмента (см.
   * QuotesService.refreshAll — молча пропускает null), в quotes остаётся прежняя
   * цена — тот самый безопасный fallback «нет свежей — берём ту, что уже есть».
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

  private readonly summary = summaryResource(this.summaryFilter);

  /** Все позиции из API */
  private readonly allPositions = computed(() => this.positionApi.positions.value() ?? []);

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
    () => new Map((this.reference.systems.value() ?? []).map((s) => [s.id, s.name])),
  );

  private readonly portfolioNames = computed(
    () => new Map((this.reference.portfolios.value() ?? []).map((p) => [p.id, p.name])),
  );

  /** Опции фильтров — только системы/портфели, которые реально встречаются в позициях */
  protected readonly systemOptions = computed(() => {
    const names = this.systemNames();
    const ids = [...new Set(this.allPositions().map((p) => p.systemId))];
    return ids.map((id) => ({ id, name: names.get(id) ?? id }));
  });

  protected readonly portfolioOptions = computed(() => {
    const names = this.portfolioNames();
    const ids = [...new Set(this.allPositions().map((p) => p.portfolioId))];
    return ids.map((id) => ({ id, name: names.get(id) ?? id }));
  });

  /** Позиции, сгруппированные по типу инструмента (с подытогом стоимости) */
  protected readonly groups = computed<Group[]>(() => {
    const byType = new Map<InstrumentType, Row[]>();
    const valueByType = new Map<InstrumentType, number>();

    for (const p of this.positions()) {
      const rows = byType.get(p.type) ?? [];
      rows.push({
        instrumentId: p.instrumentId,
        ticker: p.ticker,
        type: p.type,
        currency: p.currency,
        qty: p.quantity,
        avg: formatMoney(p.avgBuyPrice, p.currency),
        avgRaw: p.avgBuyPrice,
        current: p.currentPrice ? formatMoney(p.currentPrice, p.currency) : '—',
        value: p.currentValueRub ? formatMoney(p.currentValueRub, 'RUB') : '—',
        pnl: p.pnlRub ? formatMoney(p.pnlRub, 'RUB') : '—',
        pnlClass: p.pnlRub ? pnlColorClass(p.pnlRub) : 'pnl-zero',
        suspicious: p.currentPrice === null && Number(p.quantity) !== 0,
      });
      byType.set(p.type, rows);
      valueByType.set(p.type, (valueByType.get(p.type) ?? 0) + Number(p.currentValueRub ?? 0));
    }

    return TYPE_ORDER.filter((t) => byType.has(t)).map((t) => ({
      type: t,
      label: TYPE_LABEL[t],
      rows: byType.get(t)!,
      valueRub: valueByType.get(t) ?? 0,
    }));
  });

  /** Доли распределения для круговой диаграммы — цвет закреплён за типом инструмента */
  protected readonly allocation = computed(() =>
    this.groups().map((g) => ({ label: g.label, valueRub: g.valueRub, color: TYPE_COLOR[g.type] })),
  );

  /**
   * Итоговые карточки берём из summary().totals (та же формула и тот же фильтр,
   * что у таблицы «Эффективность» на дашборде: P&L = реализ. + нереализ. +
   * дивиденды), а НЕ суммируем построчный pnl текущих позиций — тот считает
   * только открытый остаток и не видит результат по уже закрытым сделкам.
   * Раньше это расходилось с дашбордом ровно на величину реализованного P&L
   * (напр. −84 248,81 ₽ здесь против −45 915,13 ₽ на дашборде для тех же данных).
   */
  private readonly totals = computed(() => this.summary.value()?.totals);

  protected readonly investedTotal = computed(() => formatRub(this.totals()?.investedRub));

  protected readonly valueTotal = computed(() => formatRub(this.totals()?.currentValueRub));

  protected readonly pnlTotalRaw = computed(() => this.totals()?.pnlRub ?? 0);

  protected readonly pnlTotal = computed(() => formatRub(this.pnlTotalRaw()));

  protected readonly pnlTone = computed(() => toneOf(this.pnlTotalRaw()));

  protected readonly dividendsTotal = computed(() => formatRub(this.totals()?.dividendsRub));

  protected readonly money = formatRub;

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
      { header: 'Валюта', value: (p) => p.currency },
      { header: 'Система', value: (p) => systems.get(p.systemId) ?? p.systemId },
      { header: 'Портфель', value: (p) => portfolios.get(p.portfolioId) ?? p.portfolioId },
      { header: 'Количество', value: (p) => csvNumber(p.quantity) },
      { header: 'Средняя цена', value: (p) => csvNumber(p.avgBuyPrice) },
      { header: 'Текущая цена', value: (p) => csvNumber(p.currentPrice) },
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
    this.dialog.open(ManagePortfoliosDialog, { autoFocus: false, width: '760px', maxWidth: '95vw' });
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
    await this.reference.mergeInstruments(row.instrumentId, result.targetId);
  }

  /**
   * Указать цену вручную — фоллбэк, когда resolvePrice() не находит инструмент ни
   * на одной подключённой площадке (реально внебиржевой актив, а не просто
   * не распознанный при импорте тикер).
   */
  protected async setManualPrice(row: Row): Promise<void> {
    const ref = this.dialog.open(SetManualPriceDialog, {
      autoFocus: false,
      data: { ticker: row.ticker, currency: row.currency, avgBuyPrice: row.avgRaw },
    });
    const result = await firstValueFrom(ref.afterClosed());
    if (!result) return;
    await this.api.setManualPrice(row.instrumentId, result.price);
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
