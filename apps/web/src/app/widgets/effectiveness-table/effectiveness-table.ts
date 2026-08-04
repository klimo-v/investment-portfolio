import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatSortModule } from '@angular/material/sort';
import type { Effectiveness } from '@core';
import {
  formatPercentOrDash,
  formatRub,
  Hint,
  pnlColorClass,
  sortRows,
  type SortKey,
  type SortState,
} from '@web-shared';

/** Строка разреза: метрики эффективности плюс имя системы или портфеля */
export interface EffRow extends Effectiveness {
  id: string;
  name: string;
}

/** Разрез таблицы: по торговым системам или по портфелям */
export type EffGroupBy = 'system' | 'portfolio';

/**
 * Таблица «Эффективность» — сравнение систем/портфелей между собой.
 *
 * Смысл виджета в том, что сравнивать можно только ОТНОСИТЕЛЬНЫЕ метрики: система
 * с +100 000 ₽ на вложенные 3 млн хуже, чем +60 000 ₽ на 500 тыс. Поэтому рядом с
 * рублями всегда стоят ROI и XIRR (docs/05-review-usability.md §1).
 *
 * Сортировка своя: разрез маленький (единицы строк), режется на клиенте общим
 * sortRows() — «—» (неопределённая метрика) он держит внизу при любом направлении.
 */
@Component({
  selector: 'app-effectiveness-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatTableModule, MatButtonToggleModule, MatSortModule, Hint],
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
              >P&L <app-hint [text]="pnlHint()" label="P&L" /></th
            >
            <td mat-cell *matCellDef="let r" [class]="cls(r.pnlRub)">{{ money(r.pnlRub) }}</td>
          </ng-container>
          <ng-container matColumnDef="roi">
            <th mat-header-cell *matHeaderCellDef mat-sort-header>ROI</th>
            <td mat-cell *matCellDef="let r" [class]="cls(r.roiPct ?? 0)">{{ pct(r.roiPct) }}</td>
          </ng-container>
          <ng-container matColumnDef="xirr">
            <th mat-header-cell *matHeaderCellDef mat-sort-header
              >XIRR
              <app-hint label="XIRR" text="Денежно-взвешенная годовая доходность (IRR) по фактическим датам всех вложений/выводов и текущей стоимости остатка — не то же самое, что ROI за весь период (тот не годовой). «—» означает, что результат ненадёжен: слишком короткое окно операций или доходность экстраполируется с нереалистичным перекосом (напр. одна короткая прибыльная сделка внутри длинного окна) — тогда ориентируйтесь на P&L в рублях." /></th
            >
            <td mat-cell *matCellDef="let r" [class]="cls(r.xirrPct ?? 0)">{{ pct(r.xirrPct) }}</td>
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
  /** Текст подсказки к P&L — общий со страницей, поэтому вход, а не константа */
  readonly pnlHint = input('');

  protected readonly columns = [
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

  protected readonly sortedRows = computed(() =>
    sortRows(this.rows(), this.sort(), (row, column) => this.sortKey(row, column)),
  );

  protected readonly money = formatRub;
  protected readonly pct = formatPercentOrDash;
  protected readonly cls = pnlColorClass;
}
