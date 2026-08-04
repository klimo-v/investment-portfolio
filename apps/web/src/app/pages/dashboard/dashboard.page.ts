import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatSortModule, type Sort } from '@angular/material/sort';
import { BaseChartDirective } from 'ng2-charts';
import type { ChartConfiguration } from 'chart.js';
import { maxDrawdown, type Cash, type Effectiveness } from '@core';
import {
  chartSemantic,
  Hint,
  KpiCard,
  seriesColor,
  StateMessage,
  ThemeService,
  type KpiTone,
} from '@web-shared';
import { OperationApi } from '../../entities/operation/operation.api';
import { SnapshotApi } from '../../entities/snapshot/snapshot.api';
import { BenchmarkApi } from '../../entities/benchmark/benchmark.api';
import { PositionSeriesApi } from '../../entities/position-series/position-series.api';
import { ReferenceApi } from '../../entities/reference/reference.api';
import { formatMoney, formatPercent, pnlColorClass } from '@web-shared';

/**
 * Дашборд (docs/03-ux-plan.md шаг 4; docs/05-review-usability.md §1).
 * Кроме комбо-графиков строит метрики ЭФФЕКТИВНОСТИ: доходность в % и годовых
 * (XIRR), реализ./нереализ. P&L, дивидендная доходность — по портфелю и в разрезе
 * систем/портфелей, чтобы их можно было сравнивать (абсолютный P&L сравнивать
 * нельзя). Плюс max drawdown из снимков и линия «Портфель vs IMOEX/Депозит».
 */

/**
 * Годовая ставка вклада-ориентира для линии «Депозит» (что было бы, положи те же
 * деньги на вклад). Допущение — при желании выносится в настройки; ориентир —
 * ключевая ставка периода.
 */
const DEPOSIT_ANNUAL_RATE = 0.16;

type Period = 'all' | 'ytd' | '1y' | 'custom';

interface EffRow extends Effectiveness {
  id: string;
  name: string;
}

@Component({
  selector: 'app-dashboard-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatCardModule,
    MatTableModule,
    MatButtonToggleModule,
    MatTooltipModule,
    MatFormFieldModule,
    MatSelectModule,
    MatDatepickerModule,
    MatSortModule,
    BaseChartDirective,
    KpiCard,
    Hint,
    StateMessage,
  ],
  template: `
    <div class="page-header">
      <h1 class="page-title">
        Дашборд
        @if (periodLabel(); as label) {
          <span class="period-range">({{ label }})</span>
        }
      </h1>
      <div class="filters">
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>Система</mat-label>
          <mat-select [value]="systemFilter()" (selectionChange)="systemFilter.set($event.value)">
            <mat-option [value]="null">Все</mat-option>
            @for (s of reference.systems.value(); track s.id) {
              <mat-option [value]="s.id">{{ s.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>Портфель</mat-label>
          <mat-select [value]="portfolioFilter()" (selectionChange)="portfolioFilter.set($event.value)">
            <mat-option [value]="null">Все</mat-option>
            @for (p of reference.portfolios.value(); track p.id) {
              <mat-option [value]="p.id">{{ p.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-button-toggle-group
          [value]="period()"
          (change)="period.set($event.value)"
          hideSingleSelectionIndicator
          aria-label="Период"
        >
          <mat-button-toggle value="ytd">YTD</mat-button-toggle>
          <mat-button-toggle value="1y">1 год</mat-button-toggle>
          <mat-button-toggle value="all">Всё время</mat-button-toggle>
          <mat-button-toggle value="custom">Произвольный</mat-button-toggle>
        </mat-button-toggle-group>
        <app-hint
          label="Период"
          text="Период сужает окно: Реализ./Дивиденды/P&L/ROI/XIRR и помесячный график считаются по операциям ВНУТРИ выбранного отрезка. Вложено/Текущая стоимость/Нереализ. — это состояние текущего остатка, оно не меняется от периода (себестоимость держимого нельзя посчитать иначе, чем по всей истории покупок). На коротком окне XIRR может быть не определён (—) — это статистический шум, а не ошибка."
        />
        @if (period() === 'custom') {
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="range-field">
            <mat-label>Диапазон</mat-label>
            <mat-date-range-input [rangePicker]="customPicker">
              <input
                matStartDate
                placeholder="От"
                [value]="customFrom()"
                (dateChange)="customFrom.set($event.value)"
              />
              <input
                matEndDate
                placeholder="До"
                [value]="customTill()"
                (dateChange)="customTill.set($event.value)"
              />
            </mat-date-range-input>
            <mat-datepicker-toggle matIconSuffix [for]="customPicker"></mat-datepicker-toggle>
            <mat-date-range-picker #customPicker></mat-date-range-picker>
          </mat-form-field>
        }
      </div>
    </div>

    @if (api.summary.error()) {
      <app-state-message
        kind="error"
        title="Не удалось загрузить сводку"
        hint="Проверьте, что сервер запущен, и попробуйте ещё раз."
        retryLabel="Повторить"
        (retry)="api.reload()"
      />
    } @else if (!api.summary.isLoading()) {
      <div class="kpi-grid">
        <app-kpi-card
          label="Всего в портфеле"
          [value]="money(cash().totalValueRub)"
          hint="Сколько сейчас в портфеле всего: рыночная стоимость открытых позиций плюс свободные деньги. Не зависит от выбранного периода — это величина на сегодня, а не за окно."
        />
        <app-kpi-card
          label="Позиции"
          [value]="money(totals().currentValueRub)"
          hint="Рыночная стоимость открытых позиций по последним известным ценам. Деньги на счёте сюда не входят — они в соседней карточке."
        />
        <app-kpi-card
          label="Свободные деньги"
          [value]="money(cash().cashRub)"
          [tone]="cashIncomplete() ? 'negative' : 'neutral'"
          [sub]="cashIncomplete() ? 'журнал неполон' : ''"
          hint="Остаток на счёте по журналу: пополнения − выводы − покупки + продажи + дивиденды и купоны − налоги и комиссии. Минус означает, что в журнал попали не все движения денег (пополнения, переводы между счетами, отдельные налоги/комиссии) — либо позиции набирались с плечом."
        />
        <app-kpi-card
          label="Вложено"
          [value]="money(totals().investedRub)"
          hint="Себестоимость держимого остатка — сходится с колонкой «Вложено» на странице «Сделки»"
        />

        <!--
          Единственная карточка с ручной разметкой: подстрока несёт ДВА значения со
          своими знаками (реализ./нереализ.), а строковый вход sub покрасить их не
          может. Ради одного случая усложнять app-kpi-card проекцией контента не стали.
        -->
        <mat-card class="kpi-manual">
          <mat-card-subtitle
            >P&L <app-hint [text]="pnlHint" label="P&L" /></mat-card-subtitle
          >
          <mat-card-title [class]="cls(totals().pnlRub)">{{ money(totals().pnlRub) }}</mat-card-title>
          <div class="sub">
            реализ. <span [class]="cls(totals().realizedPnlRub)">{{ money(totals().realizedPnlRub) }}</span>
            · нереализ. <span [class]="cls(totals().unrealizedPnlRub)">{{ money(totals().unrealizedPnlRub) }}</span>
          </div>
        </mat-card>

        <app-kpi-card
          label="ROI"
          [value]="pctOrDash(totals().roiPct)"
          [tone]="tone(totals().roiPct)"
          hint="P&L относительно вложенного (себестоимости держимого остатка)"
        />
        <app-kpi-card
          label="Доходность годовых (XIRR)"
          [value]="pctOrDash(totals().xirrPct)"
          [tone]="tone(totals().xirrPct)"
          hint="Денежно-взвешенная годовая доходность с учётом дат вложений"
        />
        <app-kpi-card
          label="Дивиденды + купоны"
          [value]="money(totals().dividendsRub)"
          [sub]="'доходность ' + pctOrDash(totals().dividendYieldPct)"
        />
        <app-kpi-card
          label="Макс. просадка"
          [value]="hasDrawdown() ? pctOrDash(maxDrawdownPct()) : '—'"
          [tone]="hasDrawdown() ? tone(maxDrawdownPct()) : 'neutral'"
          hint="Наибольшее падение стоимости портфеля от пика к дну по снимкам"
        />
      </div>

      <mat-card class="eff">
        <div class="eff-head">
          <h3>Эффективность</h3>
          <mat-button-toggle-group [value]="groupBy()" (change)="groupBy.set($event.value)" hideSingleSelectionIndicator>
            <mat-button-toggle value="system">По системам</mat-button-toggle>
            <mat-button-toggle value="portfolio">По портфелям</mat-button-toggle>
          </mat-button-toggle-group>
        </div>
        @if (effRows().length === 0) {
          <p class="note">Нет данных — добавьте операции и обновите цены.</p>
        } @else {
          <table mat-table matSort [dataSource]="effRows()" (matSortChange)="effSort.set($event)">
            <ng-container matColumnDef="name">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Название</th>
              <td mat-cell *matCellDef="let r">{{ r.name }}</td>
            </ng-container>
            <ng-container matColumnDef="invested">
              <th mat-header-cell *matHeaderCellDef mat-sort-header
                >Вложено
                <app-hint label="Вложено" text="Себестоимость ТЕКУЩЕГО остатка (открытых позиций). Уже закрытые (полностью проданные) позиции сюда не входят — их результат учтён отдельно в «Реализ.», а вложенный в них капитал уже вернулся при продаже. Поэтому P&L = Реализ. + Нереал. + Дивиденды, а не «Вложено − Стоимость − Дивиденды»." /></th
              >
              <td mat-cell *matCellDef="let r">{{ money(r.investedRub) }}</td>
            </ng-container>
            <ng-container matColumnDef="value">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Стоимость</th>
              <td mat-cell *matCellDef="let r">{{ money(r.currentValueRub) }}</td>
            </ng-container>
            <ng-container matColumnDef="realized">
              <th mat-header-cell *matHeaderCellDef mat-sort-header
                >Реализ. / Нереализ.
                <app-hint label="Реализ. / Нереализ." text="Реализ. — результат от продаж ВНУТРИ выбранного периода (себестоимость проданного всё равно берётся по всей истории покупок). Нереал. — бумажная переоценка того, что держите сейчас (Стоимость − Вложено), от периода не зависит. P&L складывается из обоих плюс дивиденды/купоны." /></th
              >
              <td mat-cell *matCellDef="let r">
                <span [class]="cls(r.realizedPnlRub)">{{ money(r.realizedPnlRub) }}</span>
                /
                <span [class]="cls(r.unrealizedPnlRub)">{{ money(r.unrealizedPnlRub) }}</span>
              </td>
            </ng-container>
            <ng-container matColumnDef="pnl">
              <th mat-header-cell *matHeaderCellDef mat-sort-header
                >P&L <app-hint [text]="pnlHint" label="P&L" /></th
              >
              <td mat-cell *matCellDef="let r" [class]="cls(r.pnlRub)">{{ money(r.pnlRub) }}</td>
            </ng-container>
            <ng-container matColumnDef="roi">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>ROI</th>
              <td mat-cell *matCellDef="let r" [class]="cls(r.roiPct ?? 0)">{{ pctOrDash(r.roiPct) }}</td>
            </ng-container>
            <ng-container matColumnDef="xirr">
              <th mat-header-cell *matHeaderCellDef mat-sort-header
                >XIRR
                <app-hint label="XIRR" text="Денежно-взвешенная годовая доходность (IRR) по фактическим датам всех вложений/выводов и текущей стоимости остатка — не то же самое, что ROI за весь период (тот не годовой). «—» означает, что результат ненадёжен: слишком короткое окно операций или доходность экстраполируется с нереалистичным перекосом (напр. одна короткая прибыльная сделка внутри длинного окна) — тогда ориентируйтесь на P&L в рублях." /></th
              >
              <td mat-cell *matCellDef="let r" [class]="cls(r.xirrPct ?? 0)">{{ pctOrDash(r.xirrPct) }}</td>
            </ng-container>
            <ng-container matColumnDef="dividends">
              <th mat-header-cell *matHeaderCellDef mat-sort-header
                >Дивиденды
                <app-hint label="Дивиденды" text="Дивиденды и купоны, полученные вами деньгами ВНУТРИ выбранного периода — сумма операций типа «Дивиденд»/«Купон» из журнала, как есть. Именно эта сумма и входит в P&L (см. подсказку у P&L)." /></th
              >
              <td mat-cell *matCellDef="let r">{{ money(r.dividendsRub) }}</td>
            </ng-container>
            <ng-container matColumnDef="divyield">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Див. дох.</th>
              <td mat-cell *matCellDef="let r">{{ pctOrDash(r.dividendYieldPct) }}</td>
            </ng-container>
            <tr mat-header-row *matHeaderRowDef="effColumns"></tr>
            <tr mat-row *matRowDef="let row; columns: effColumns"></tr>
          </table>
        }
      </mat-card>

      <div class="charts">
        <mat-card class="wide">
          <h3>Портфель против рынка</h3>
          <p class="note">
            Рост ₽100, вложенных в начале периода: ваш портфель, индекс МосБиржи (IMOEX)
            и вклад под {{ depositRatePct }}% годовых. По снимкам стоимости.
            @if (segmentFilterActive()) {
              Снимки не разбиты по системам/портфелям — график показывает портфель целиком.
            }
          </p>
          @if (benchmarkChart(); as bc) {
            <div class="chart-box">
              <canvas baseChart [type]="bc.type" [data]="bc.data" [options]="bc.options"></canvas>
            </div>
          } @else {
            <p class="note">
              Нужно минимум два снимка стоимости и данные индекса. Снимки появляются на
              странице «Портфель» при нажатии «Обновить цены».
            </p>
          }
        </mat-card>

        <mat-card class="wide">
          <h3>Стоимость инструментов во времени</h3>
          <p class="note">
            Стоимость каждого инструмента и итог по портфелю по датам снимков; пунктир —
            внесено (нетто): депозиты минус выводы, чтобы отделить рост от довнесения
            капитала. Сумма линий = «Текущая стоимость» портфеля. Снимки копятся при
            «Обновить цены» на странице «Портфель» (по одному в день).
            @if (segmentFilterActive()) {
              Разбивка не делится по системам/портфелям — показан портфель целиком.
            }
          </p>
          @if (positionsChart(); as pc) {
            <div class="chart-box tall">
              <canvas baseChart [type]="pc.type" [data]="pc.data" [options]="pc.options"></canvas>
            </div>
          } @else {
            <p class="note">
              Снимков пока нет — они появляются на странице «Портфель» при нажатии
              «Обновить цены» (по одному снимку в день).
            </p>
          }
        </mat-card>

        <mat-card>
          <h3>Поток и доход по месяцам</h3>
          <p class="note">
            Столбцы на одной оске: поток кэша (депозиты/выводы) и доход (дивиденды/купоны).
          </p>
          @if (timelineChart(); as tc) {
            <div class="chart-box">
              <canvas baseChart [type]="tc.type" [data]="tc.data" [options]="tc.options"></canvas>
            </div>
          } @else {
            <app-state-message
              kind="empty"
              icon="bar_chart"
              title="Нет движений за период"
              hint="Здесь появятся депозиты, выводы и полученные дивиденды по месяцам."
            />
          }
        </mat-card>

        <mat-card>
          <h3>P&L по системам</h3>
          @if (systemChart(); as sc) {
            <div class="chart-box">
              <canvas baseChart [type]="sc.type" [data]="sc.data" [options]="sc.options"></canvas>
            </div>
          } @else {
            <app-state-message
              kind="empty"
              icon="bar_chart"
              title="Нет данных по системам"
              hint="Добавьте операции — P&L разложится по торговым системам."
            />
          }
        </mat-card>

        <mat-card class="wide">
          <h3>Прибыль / убыток по инструментам</h3>
          @if (breakdownChart(); as bc) {
            <div class="chart-box tall">
              <canvas baseChart [type]="bc.type" [data]="bc.data" [options]="bc.options"></canvas>
            </div>
          } @else {
            <app-state-message
              kind="empty"
              icon="bar_chart"
              title="Нет данных по инструментам"
              hint="Обновите цены на странице «Портфель», чтобы увидеть прибыль и убыток по тикерам."
            />
          }
        </mat-card>
      </div>
    }
  `,
  styles: [
    `
      /* .filters — глобальный (styles.scss): переносится, поля тянутся */
      .period-range {
        font-size: 14px;
        font-weight: 400;
        color: var(--app-text-muted);
        white-space: nowrap;
        margin-left: 8px;
      }
      /* Ручная карточка внутри .kpi-grid — повторяет геометрию app-kpi-card */
      .kpi-manual {
        padding: 16px;
        height: 100%;
        box-sizing: border-box;
      }
      .sub {
        margin-top: 4px;
        font-size: 12px;
        color: var(--app-text-muted);
      }
      .hint {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        /* --app-text-muted, а не --app-outline: outline-variant в M3 намеренно
           малоконтрастен (для разделителей), и бейдж «?» на нём почти пропадает */
        border: 1px solid var(--app-text-muted);
        color: var(--app-text-muted);
        font-size: 10px;
        cursor: help;
      }
      .eff {
        padding: 16px;
        margin-bottom: 16px;
        overflow-x: auto;
      }
      .eff-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      .eff-head h3 {
        margin: 0;
        font-weight: 500;
      }
      .eff table {
        width: 100%;
      }
      /*
       * auto-fit + minmax вместо жёстких двух колонок: на узком экране график
       * шириной в пол-контейнера превращался в нечитаемую полоску, а медиазапрос по
       * вьюпорту не учёл бы, что сайднав тоже съедает ширину.
       */
      .charts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
        gap: 16px;
      }
      .charts mat-card {
        padding: 16px;
      }
      .charts .wide {
        grid-column: 1 / -1;
      }
      h3 {
        margin: 0 0 8px;
        font-weight: 500;
      }
      .note {
        margin: 0 0 12px;
        font-size: 13px;
        color: var(--app-text-muted);
      }
      /* .chart-box, .pnl-*, .error — глобальные (styles.scss), локальных копий не держим */
    `,
  ],
})
export class DashboardPage {
  protected readonly api = inject(OperationApi);
  protected readonly snapshots = inject(SnapshotApi);
  protected readonly benchmark = inject(BenchmarkApi);
  protected readonly positionSeries = inject(PositionSeriesApi);
  protected readonly reference = inject(ReferenceApi);
  private readonly theme = inject(ThemeService);

  protected readonly depositRatePct = (DEPOSIT_ANNUAL_RATE * 100).toFixed(0);
  protected readonly groupBy = signal<'system' | 'portfolio'>('system');

  /**
   * P&L = реализ. + нереализ. + дивиденды. Реализ./дивиденды — за выбранный период
   * (продажи/выплаты внутри окна), нереализ. — состояние остатка сейчас. Частый
   * вопрос: «Вложено − Стоимость − Дивиденды» даёт другое число, потому что
   * молча выбрасывает уже зафиксированную реализованную прибыль/убыток.
   */
  protected readonly pnlHint =
    'P&L = реализ. + нереализ. + дивиденды/купоны за выбранный период. Реализ./' +
    'дивиденды — от продаж/выплат ВНУТРИ периода, эти деньги уже ваши независимо ' +
    'от того, вывели вы их или реинвестировали. Нереализ. — переоценка текущего ' +
    'остатка, от периода не зависит. «Вложено − Стоимость − Дивиденды» даст другое ' +
    'число — оно молча теряет уже зафиксированную реализованную прибыль/убыток.';

  /** Глобальный фильтр дашборда (docs/05-review-usability.md §2) */
  protected readonly systemFilter = signal<string | null>(null);
  protected readonly portfolioFilter = signal<string | null>(null);
  protected readonly period = signal<Period>('all');
  /** Границы произвольного диапазона (период 'custom') */
  protected readonly customFrom = signal<Date | null>(null);
  protected readonly customTill = signal<Date | null>(null);

  /** true, когда выбран конкретный система/портфель — снимки стоимости их не различают */
  protected readonly segmentFilterActive = computed(
    () => this.systemFilter() !== null || this.portfolioFilter() !== null,
  );

  /**
   * Период → диапазон дат от/до; 'all' — без ограничения. 'custom' — пока не
   * выбраны обе границы в date-range picker'е, ведёт себя как 'all' (не режем
   * потоки по одной случайно введённой дате).
   */
  private readonly periodRange = computed<{ from?: string; till?: string }>(() => {
    const p = this.period();
    if (p === 'all') return {};
    if (p === 'custom') {
      const from = this.customFrom();
      const till = this.customTill();
      if (!from || !till) return {};
      return { from: this.toIsoDate(from), till: this.toIsoDate(till) };
    }
    const till = new Date().toISOString().slice(0, 10);
    const from = new Date();
    if (p === 'ytd') from.setMonth(0, 1);
    else from.setFullYear(from.getFullYear() - 1);
    return { from: from.toISOString().slice(0, 10), till };
  });

  /**
   * Дата пикера → YYYY-MM-DD по ЛОКАЛЬНЫМ компонентам, не через toISOString():
   * тот конвертирует через UTC и на выбранной пользователем календарной дате
   * (локальная полночь) может откатить/подвинуть день в зависимости от часового
   * пояса браузера — пользователь выбрал 1 июля, а фильтр получил бы 30 июня.
   */
  private toIsoDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * Видимая подпись выбранного периода (напр. «01.01.2026 – 29.07.2026»), чтобы
   * не гадать, за какой именно год считается XIRR — тумблер сам по себе диапазон
   * не показывает.
   */
  protected readonly periodLabel = computed<string | null>(() => {
    const r = this.periodRange();
    if (!r.from || !r.till) return null;
    const fmt = (iso: string) => {
      const [y, m, d] = iso.split('-');
      return `${d}.${m}.${y}`;
    };
    return `${fmt(r.from)} – ${fmt(r.till)}`;
  });

  protected readonly effColumns = [
    'name',
    'invested',
    'value',
    'realized',
    'pnl',
    'roi',
    'xirr',
    'dividends',
    'divyield',
  ];

  private static readonly EMPTY: Effectiveness = {
    investedRub: 0,
    currentValueRub: 0,
    realizedPnlRub: 0,
    unrealizedPnlRub: 0,
    dividendsRub: 0,
    pnlRub: 0,
    roiPct: null,
    dividendYieldPct: null,
    xirrPct: null,
  };

  protected readonly totals = computed<Effectiveness>(
    () => this.api.summary.value()?.totals ?? DashboardPage.EMPTY,
  );

  private static readonly EMPTY_CASH: Cash = { cashRub: 0, totalValueRub: 0 };

  /** Свободные деньги и «всего в портфеле» — стоимость позиций плюс кэш */
  protected readonly cash = computed<Cash>(
    () => this.api.summary.value()?.cash ?? DashboardPage.EMPTY_CASH,
  );

  /**
   * Остаток ушёл в минус — значит журнал не содержит части денежных движений
   * (см. cash.ts). Подписываем это прямо на карточке, а не прячем: минус здесь
   * информативнее пустого места.
   */
  protected readonly cashIncomplete = computed(() => this.cash().cashRub < 0);

  /** Текущая сортировка таблицы «Эффективность»; пустое direction — порядок с сервера */
  protected readonly effSort = signal<Sort>({ active: '', direction: '' });

  /**
   * Ключ строки по имени колонки. Возвращает `string | number`, потому что
   * «Название» сравнивается лексикографически, а остальные — численно.
   * null (метрика не определена) всегда уезжает вниз — см. compare().
   */
  private effValue(row: EffRow, column: string): string | number | null {
    switch (column) {
      case 'name':
        return row.name;
      case 'invested':
        return row.investedRub;
      case 'value':
        return row.currentValueRub;
      case 'realized':
        return row.realizedPnlRub;
      case 'pnl':
        return row.pnlRub;
      case 'roi':
        return row.roiPct;
      case 'xirr':
        return row.xirrPct;
      case 'dividends':
        return row.dividendsRub;
      case 'divyield':
        return row.dividendYieldPct;
      default:
        return null;
    }
  }

  /** Строки таблицы эффективности — по системам или по портфелям, с учётом сортировки */
  protected readonly effRows = computed<EffRow[]>(() => {
    const s = this.api.summary.value();
    if (!s) return [];
    const rows =
      this.groupBy() === 'system'
        ? s.bySystem.map((r) => ({ ...r, id: r.systemId }))
        : s.byPortfolio.map((r) => ({ ...r, id: r.portfolioId }));

    const { active, direction } = this.effSort();
    if (!active || !direction) return rows;

    const sign = direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = this.effValue(a, active);
      const bv = this.effValue(b, active);
      // «—» (метрика не определена) держим внизу при ЛЮБОМ направлении: иначе при
      // сортировке по XIRR вверх список начинается с прочерков, а не с худших чисел
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === 'string' || typeof bv === 'string') {
        return sign * String(av).localeCompare(String(bv), 'ru');
      }
      return sign * (av - bv);
    });
  });

  /**
   * Снимки по возрастанию даты, обрезанные под выбранный период (для просадки,
   * бенчмарка и графика динамики). Снимки не разбиты по системам/портфелям
   * (см. segmentFilterActive), поэтому system/portfolio фильтр их не сужает.
   */
  private readonly snaps = computed(() => {
    const all = [...(this.snapshots.list.value() ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    const r = this.periodRange();
    return all.filter((s) => (!r.from || s.date >= r.from) && (!r.till || s.date <= r.till));
  });

  protected readonly hasDrawdown = computed(() => this.snaps().length >= 2);
  /** Макс. просадка стоимости портфеля по снимкам (доля ≤ 0 → в %) */
  protected readonly maxDrawdownPct = computed(
    () => maxDrawdown(this.snaps().map((s) => s.currentValueRub)) * 100,
  );

  constructor() {
    // Прокидываем фильтр в OperationApi — summary() пересчитывается на сервере
    effect(() => {
      const r = this.periodRange();
      this.api.summaryFilter.set({
        systemId: this.systemFilter() ?? undefined,
        portfolioId: this.portfolioFilter() ?? undefined,
        from: r.from,
        till: r.till,
      });
    });

    // Диапазон запроса истории индекса — от первого (отфильтрованного по периоду)
    // снимка до сегодня
    effect(() => {
      const s = this.snaps();
      if (s.length < 2) {
        this.benchmark.range.set(null);
        return;
      }
      this.benchmark.range.set({ from: s[0].date, till: new Date().toISOString().slice(0, 10) });
    });
  }

  /**
   * Смысловые цвета графиков под текущую тему. Читается внутри чарт-computed()'ов,
   * поэтому при переключении темы все они пересобираются сами — без effect'ов и
   * ручного chart.update() (CLAUDE.md §4).
   */
  private readonly cc = computed(() => chartSemantic(this.theme.isDark()));

  /**
   * «Стоимость инструментов во времени»: по линии на инструмент (RUB, null —
   * инструмент в эту дату не удерживался → разрыв), жирная линия «Итого» (сумма) и
   * пунктирная «Внесено (нетто)» — накопленный чистый ввод средств, чтобы отделить
   * рост стоимости от довнесения капитала. Данные — из snapshot_positions (ряд
   * собирается кнопкой «Пересобрать историю»). null — истории ещё нет.
   */
  protected readonly positionsChart = computed<ChartConfiguration<'line'> | null>(() => {
    const s = this.positionSeries.series.value();
    if (!s || s.dates.length === 0) return null;

    const instrumentDatasets = s.instruments.map((ins, i) => ({
      label: ins.ticker,
      data: ins.values,
      borderColor: seriesColor(i),
      backgroundColor: seriesColor(i),
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.2,
      spanGaps: false,
    }));

    return {
      type: 'line',
      data: {
        labels: s.dates,
        datasets: [
          ...instrumentDatasets,
          {
            label: 'Итого',
            data: s.total,
            borderColor: this.cc().total,
            backgroundColor: this.cc().total,
            borderWidth: 2.5,
            pointRadius: 0,
            tension: 0.2,
          },
          {
            label: 'Внесено (нетто)',
            data: s.netContributions,
            borderColor: this.cc().neutral,
            backgroundColor: this.cc().neutral,
            borderWidth: 2,
            borderDash: [6, 4],
            pointRadius: 0,
            tension: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, position: 'bottom' },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${this.money(c.parsed.y)}` } },
        },
        scales: {
          x: { grid: { display: false } },
          y: { ticks: { callback: (v) => '₽' + Math.round(Number(v) / 1000) + 'k' } },
        },
      },
    };
  });

  /**
   * Линия «Портфель vs рынок»: рост ₽100 от начала периода. Портфель — по снимкам
   * стоимости, IMOEX — по истории индекса (выравнивается на дату снимка: берём
   * последнее закрытие на дату или раньше), Депозит — фиксированная ставка.
   * null — если данных для сравнения недостаточно.
   */
  protected readonly benchmarkChart = computed<ChartConfiguration<'line'> | null>(() => {
    const s = this.snaps();
    const b = [...(this.benchmark.history.value() ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    if (s.length < 2 || b.length === 0) return null;

    const baseValue = s[0].currentValueRub > 0 ? s[0].currentValueRub : s[0].investedRub;
    if (baseValue <= 0) return null;

    const closeOnOrBefore = (date: string): number => {
      let close = b[0].close;
      for (const p of b) {
        if (p.date <= date) close = p.close;
        else break;
      }
      return close;
    };
    const baseClose = closeOnOrBefore(s[0].date);
    const baseTime = new Date(s[0].date + 'T00:00:00Z').getTime();
    const dayMs = 24 * 60 * 60 * 1000;

    const portfolio = s.map((r) => (r.currentValueRub / baseValue) * 100);
    const imoex = s.map((r) => (closeOnOrBefore(r.date) / baseClose) * 100);
    const deposit = s.map((r) => {
      const years = (new Date(r.date + 'T00:00:00Z').getTime() - baseTime) / dayMs / 365;
      return 100 * Math.pow(1 + DEPOSIT_ANNUAL_RATE, years);
    });

    return {
      type: 'line',
      data: {
        labels: s.map((r) => r.date),
        datasets: [
          { label: 'Портфель', data: portfolio, borderColor: seriesColor(0), backgroundColor: seriesColor(0), pointRadius: 2, tension: 0.2 },
          { label: 'IMOEX', data: imoex, borderColor: this.cc().benchmark, backgroundColor: this.cc().benchmark, pointRadius: 2, tension: 0.2 },
          { label: 'Депозит', data: deposit, borderColor: this.cc().deposit, backgroundColor: this.cc().deposit, pointRadius: 0, borderDash: [6, 4], tension: 0 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${Number(c.parsed.y).toFixed(1)}` } },
        },
        scales: {
          x: { grid: { display: false } },
          y: { ticks: { callback: (v) => Number(v).toFixed(0) } },
        },
      },
    };
  });

  /** Комбо по месяцам: столбцы Поток (серый) и Доход (зелёный/красный по знаку) */
  protected readonly timelineChart = computed<ChartConfiguration<'bar'> | null>(() => {
    const t = this.api.summary.value()?.timeline ?? [];
    if (t.length === 0) return null;
    const incomeColors = t.map((r) => (r.income >= 0 ? this.cc().positive : this.cc().negative));
    return {
      type: 'bar',
      data: {
        labels: t.map((r) => r.period),
        datasets: [
          { label: 'Поток', data: t.map((r) => r.flow), backgroundColor: this.cc().neutral, borderRadius: 3 },
          {
            label: 'Доход',
            data: t.map((r) => r.income),
            backgroundColor: incomeColors,
            borderRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${this.money(c.parsed.y)}` } },
        },
        scales: {
          x: { grid: { display: false } },
          y: { ticks: { callback: (v) => '₽' + Math.round(Number(v) / 1000) + 'k' } },
        },
      },
    };
  });

  /** P&L по системам: столбцы, цвет по знаку */
  protected readonly systemChart = computed<ChartConfiguration<'bar'> | null>(() => {
    const s = this.api.summary.value()?.bySystem ?? [];
    if (s.length === 0) return null;
    return {
      type: 'bar',
      data: {
        labels: s.map((r) => r.name),
        datasets: [
          {
            label: 'P&L ₽',
            data: s.map((r) => r.pnlRub),
            backgroundColor: s.map((r) => (r.pnlRub >= 0 ? this.cc().positive : this.cc().negative)),
            borderRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => this.money(c.parsed.y) } },
        },
        scales: { y: { ticks: { callback: (v) => '₽' + Math.round(Number(v) / 1000) + 'k' } } },
      },
    };
  });

  /** Breakdown по инструментам: горизонтальные бары, цвет по знаку */
  protected readonly breakdownChart = computed<ChartConfiguration<'bar'> | null>(() => {
    const b = this.api.summary.value()?.breakdown ?? [];
    if (b.length === 0) return null;
    return {
      type: 'bar',
      data: {
        labels: b.map((r) => r.ticker),
        datasets: [
          {
            label: 'P&L ₽',
            data: b.map((r) => r.pnlRub),
            backgroundColor: b.map((r) => (r.pnlRub >= 0 ? this.cc().positive : this.cc().negative)),
            borderRadius: 3,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => this.money(c.parsed.x) } },
        },
        scales: { x: { ticks: { callback: (v) => '₽' + Math.round(Number(v) / 1000) + 'k' } } },
      },
    };
  });

  protected money(v: number | null): string {
    return formatMoney((v ?? 0).toFixed(2), 'RUB');
  }

  /** Процент или «—», если метрика не определена (например, вложено = 0) */
  protected pctOrDash(v: number | null): string {
    return v === null ? '—' : formatPercent(v);
  }

  protected cls(v: number): string {
    return pnlColorClass(v);
  }

  /**
   * Знак метрики для app-kpi-card. null (метрика не определена) — нейтральный тон:
   * прочерк не должен зеленеть или краснеть.
   */
  protected tone(v: number | null): KpiTone {
    if (v === null || v === 0) return 'neutral';
    return v > 0 ? 'positive' : 'negative';
  }
}
