import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatSortModule } from '@angular/material/sort';
import { RouterLink } from '@angular/router';
import type { PeriodPerformanceDto } from '@core';
import {
  formatPercentOrDash,
  formatRub,
  formatValuation,
  Hint,
  pnlColorClass,
  sortRows,
  type SortKey,
  type SortState,
} from '@web-shared';

/**
 * Строка разреза: суммы на сегодня (вложено/стоимость/дивиденды — из сводки) плюс доходность
 * за период из единого расчёта (GET /api/performance) — одна и та же функция для любой строки.
 */
export interface EffRow {
  id: string;
  name: string;
  investedRub: number;
  currentValueRub: number | null;
  unvaluedPositionCount: number;
  dividendsRub: number;
  dividendYieldPct: number | null;
  performance: PeriodPerformanceDto;
}

/** Разрез таблицы: по торговым системам или по портфелям */
export type EffGroupBy = 'system' | 'portfolio';

/**
 * Таблица «Эффективность» — сравнение систем/портфелей между собой.
 *
 * Смысл виджета в том, что сравнивать можно только ОТНОСИТЕЛЬНЫЕ метрики: система
 * с +100 000 ₽ на вложенные 3 млн хуже, чем +60 000 ₽ на 500 тыс. Поэтому рядом с
 * рублями всегда стоят доходность стратегии (TWR) и доходность денег — обе из единого расчёта
 * периода (docs/02-data-model.md).
 *
 * Сортировка своя: разрез маленький (единицы строк), режется на клиенте общим
 * sortRows() — «—» (неопределённая метрика) он держит внизу при любом направлении.
 */
@Component({
  selector: 'app-effectiveness-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatTableModule, MatButtonToggleModule, MatSortModule, RouterLink, Hint],
  template: `
    <mat-card class="eff">
      <div class="eff-head">
        <h3>Эффективность</h3>
        <mat-button-toggle-group
          [value]="groupBy()"
          (change)="groupByChange.emit($event.value)"
          hideSingleSelectionIndicator
        >
          <mat-button-toggle value="system">По системам</mat-button-toggle>
          <mat-button-toggle value="portfolio">По портфелям</mat-button-toggle>
        </mat-button-toggle-group>
      </div>
      @if (sortedRows().length === 0) {
        <p class="note">Нет данных — добавьте операции и обновите цены.</p>
      } @else {
        <table
          mat-table
          matSort
          [matSortActive]="sort().active"
          [matSortDirection]="sort().direction"
          [dataSource]="sortedRows()"
          (matSortChange)="sort.set($event)"
        >
          <ng-container matColumnDef="name">
            <th mat-header-cell *matHeaderCellDef mat-sort-header>Название</th>
            <td mat-cell *matCellDef="let r">
              @if (groupBy() === 'system') {
                <a [routerLink]="['/systems', r.id]" [queryParams]="portfolioId() ? { portfolio: portfolioId() } : null">{{ r.name }}</a>
              } @else {
                {{ r.name }}
              }
            </td>
          </ng-container>
          <ng-container matColumnDef="invested">
            <th mat-header-cell *matHeaderCellDef mat-sort-header
              >Вложено
              <app-hint label="Вложено" text="Себестоимость ТЕКУЩЕГО остатка (открытых позиций). Уже закрытые (полностью проданные) позиции сюда не входят — их результат учтён в «Зафикс.», а вложенный в них капитал уже вернулся при продаже. Это величина на сегодня, а не за период." /></th
            >
            <td mat-cell *matCellDef="let r">{{ money(r.investedRub) }}</td>
          </ng-container>
          <ng-container matColumnDef="value">
            <th mat-header-cell *matHeaderCellDef mat-sort-header>Стоимость</th>
            <td mat-cell *matCellDef="let r">{{ valuation(r.currentValueRub, r.unvaluedPositionCount) }}</td>
          </ng-container>
          <ng-container matColumnDef="realized">
            <th mat-header-cell *matHeaderCellDef mat-sort-header
              >Зафикс. / Переоценка
              <app-hint label="Зафикс. / Переоценка" text="Зафикс. — продажи и выплаты (дивиденды, купоны) ВНУТРИ выбранного периода. Переоценка — изменение стоимости остатка именно за период: прибыль, заработанная до его начала, сюда не входит. Вместе они дают «Результат»." /></th
            >
            <td mat-cell *matCellDef="let r">
              <span [class]="cls(num(r.performance.breakdown.fixedRub))">{{ money(num(r.performance.breakdown.fixedRub)) }}</span>
              /
              <span [class]="cls(r.unvaluedPositionCount > 0 ? 0 : num(r.performance.breakdown.revaluationRub))">{{ money(r.unvaluedPositionCount > 0 ? null : num(r.performance.breakdown.revaluationRub)) }}</span>
            </td>
          </ng-container>
          <ng-container matColumnDef="pnl">
            <th mat-header-cell *matHeaderCellDef mat-sort-header
              >Результат <app-hint [text]="pnlHint()" label="Результат" /></th
            >
            <td mat-cell *matCellDef="let r" [class]="cls(r.unvaluedPositionCount > 0 ? 0 : num(r.performance.resultRub))">{{ money(r.unvaluedPositionCount > 0 ? null : num(r.performance.resultRub)) }}</td>
          </ng-container>
          <ng-container matColumnDef="twr">
            <th mat-header-cell *matHeaderCellDef mat-sort-header
              >Доходность (TWR)
              <app-hint label="Доходность (TWR)" text="Time-weighted return: доходность капитала независимо от того, когда вы вносили и выводили деньги. Сравнима между строками и с индексом. «—» — за период не было капитала (например, система только из фьючерсов): смотрите результат в рублях." /></th
            >
            <td mat-cell *matCellDef="let r" [class]="cls(r.performance.twr.pct ?? 0)">{{ pct(r.performance.twr.pct) }}</td>
          </ng-container>
          <ng-container matColumnDef="mwr">
            <th mat-header-cell *matHeaderCellDef mat-sort-header
              >Доходность денег
              <app-hint label="Доходность денег" text="Доходность ваших денег с учётом сумм и дат вводов. Период от года — в годовых (XIRR), короче — за период (результат / средний капитал). Может отличаться от TWR: так бывает, когда крупный ввод пришёлся перед ростом или падением." /></th
            >
            <td mat-cell *matCellDef="let r" [class]="cls(r.performance.mwr.pct ?? 0)">
              {{ pct(r.performance.mwr.pct) }}
              @if (r.performance.mwr.pct !== null) {
                <span class="unit">{{ r.performance.mwr.kind === 'annual' ? 'год.' : 'за период' }}</span>
              }
            </td>
          </ng-container>
          <ng-container matColumnDef="dividends">
            <th mat-header-cell *matHeaderCellDef mat-sort-header
              >Дивиденды
              <app-hint label="Дивиденды" text="Дивиденды и купоны, полученные вами деньгами ВНУТРИ выбранного периода — сумма операций типа «Дивиденд»/«Купон» из журнала, как есть. Эта сумма входит в «Зафикс.» и в «Результат»." /></th
            >
            <td mat-cell *matCellDef="let r">{{ money(r.dividendsRub) }}</td>
          </ng-container>
          <ng-container matColumnDef="divyield">
            <th mat-header-cell *matHeaderCellDef mat-sort-header>Див. дох.</th>
            <td mat-cell *matCellDef="let r">{{ pct(r.dividendYieldPct) }}</td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="columns"></tr>
          <tr mat-row *matRowDef="let row; columns: columns"></tr>
        </table>
      }
    </mat-card>
  `,
  styles: [
    `
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
      table {
        width: 100%;
      }
      .unit {
        font-size: 11px;
        color: var(--app-text-muted);
      }
      .note {
        margin: 0;
        font-size: 13px;
        color: var(--app-text-muted);
      }
    `,
  ],
})
export class EffectivenessTable {
  readonly rows = input<readonly EffRow[]>([]);
  readonly groupBy = input.required<EffGroupBy>();
  /** Разрез выбирает страница — он же определяет, какие строки сюда приедут */
  readonly groupByChange = output<EffGroupBy>();
  /** Текст подсказки к «Результату» — общий со страницей, поэтому вход, а не константа */
  readonly pnlHint = input('');
  /** Выбранный портфель — уходит в ссылку на страницу системы, чтобы срез сохранился */
  readonly portfolioId = input<string | null>(null);

  protected readonly columns = [
    'name',
    'invested',
    'value',
    'realized',
    'pnl',
    'twr',
    'mwr',
    'dividends',
    'divyield',
  ];

  /** Пустое direction — порядок, в котором строки пришли с сервера */
  protected readonly sort = signal<SortState>({ active: '', direction: '' });

  private sortKey(row: EffRow, column: string): SortKey {
    switch (column) {
      case 'name':
        return row.name;
      case 'invested':
        return row.investedRub;
      case 'value':
        return row.currentValueRub;
      case 'realized':
        return Number(row.performance.breakdown.fixedRub);
      case 'pnl':
        return row.unvaluedPositionCount > 0 ? null : Number(row.performance.resultRub);
      case 'twr':
        return row.performance.twr.pct;
      case 'mwr':
        return row.performance.mwr.pct;
      case 'dividends':
        return row.dividendsRub;
      case 'divyield':
        return row.dividendYieldPct;
      default:
        return null;
    }
  }

  protected readonly sortedRows = computed(() =>
    sortRows(this.rows(), this.sort(), (row, column) => this.sortKey(row, column)),
  );

  protected num(v: string): number {
    return Number(v);
  }

  protected readonly money = formatRub;
  protected readonly valuation = formatValuation;
  protected readonly pct = formatPercentOrDash;
  protected readonly cls = pnlColorClass;
}
