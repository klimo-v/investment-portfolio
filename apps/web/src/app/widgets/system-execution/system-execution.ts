import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import type { ExecutionStats } from '@core';
import { formatMoney, KpiCard, pnlColorClass } from '@web-shared';

/**
 * Блок «Исполнение»: проскальзывание от сигнальной цены и результат по тегу входа.
 * Показывается страницей только если загружены данные исполнения (CSV) — без них
 * страница системы полна и без этого блока. Только форматирует цифры DTO.
 */
@Component({
  selector: 'app-system-execution',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatTableModule, KpiCard],
  template: `
    <h2 class="title">Исполнение</h2>
    <div class="kpi-grid">
      <app-kpi-card
        label="Проскальзывание, всего"
        [value]="money(execution().totalSlippageRub)"
        [tone]="Number(execution().totalSlippageRub) > 0 ? 'negative' : 'neutral'"
        sub="плюс = потеряли относительно сигнальной цены"
        hint="Для покупки (цена исполнения − сигнальная) × кол-во, для продажи (сигнальная − цена исполнения) × кол-во. Считается по исполнениям, у которых есть сигнальная цена."
      />
      <app-kpi-card
        label="На контракт"
        [value]="execution().avgSlippagePerContractRub ? money(execution().avgSlippagePerContractRub!) : '—'"
        [sub]="'контрактов с сигналом: ' + execution().contractsWithSignal"
      />
      <app-kpi-card label="Аннотированных исполнений" [value]="execution().fills.toString()" />
    </div>

    <div class="tables">
      <mat-card>
        <h3>Проскальзывание по тегам</h3>
        <table mat-table [dataSource]="execution().byTag">
          <ng-container matColumnDef="tag">
            <th mat-header-cell *matHeaderCellDef>Тег</th>
            <td mat-cell *matCellDef="let r">{{ r.tag ?? 'без тега' }}</td>
          </ng-container>
          <ng-container matColumnDef="fills">
            <th mat-header-cell *matHeaderCellDef>Исполнений</th>
            <td mat-cell *matCellDef="let r">{{ r.fills }}</td>
          </ng-container>
          <ng-container matColumnDef="slip">
            <th mat-header-cell *matHeaderCellDef>Проскальзывание</th>
            <td mat-cell *matCellDef="let r">{{ money(r.slippageRub) }}</td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="slipColumns"></tr>
          <tr mat-row *matRowDef="let row; columns: slipColumns"></tr>
        </table>
      </mat-card>
      <mat-card>
        <h3>Закрытые сделки по тегу входа</h3>
        <table mat-table [dataSource]="execution().byEntryTag">
          <ng-container matColumnDef="tag">
            <th mat-header-cell *matHeaderCellDef>Тег входа</th>
            <td mat-cell *matCellDef="let r">{{ r.tag ?? 'без тега' }}</td>
          </ng-container>
          <ng-container matColumnDef="trades">
            <th mat-header-cell *matHeaderCellDef>Сделок</th>
            <td mat-cell *matCellDef="let r">{{ r.trades }}</td>
          </ng-container>
          <ng-container matColumnDef="win">
            <th mat-header-cell *matHeaderCellDef>Win rate</th>
            <td mat-cell *matCellDef="let r">{{ r.winRatePct === null ? '—' : r.winRatePct.toFixed(0) + '%' }}</td>
          </ng-container>
          <ng-container matColumnDef="net">
            <th mat-header-cell *matHeaderCellDef>Результат</th>
            <td mat-cell *matCellDef="let r" [class]="cls(r.netPnlRub)">{{ money(r.netPnlRub) }}</td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="entryColumns"></tr>
          <tr mat-row *matRowDef="let row; columns: entryColumns"></tr>
        </table>
      </mat-card>
    </div>
  `,
  styles: [
    `
      .title {
        margin: 16px 0 8px;
        font-size: 18px;
        font-weight: 500;
      }
      .tables {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
        gap: 16px;
      }
      mat-card {
        padding: 16px;
        overflow-x: auto;
      }
      h3 {
        margin: 0 0 8px;
        font-weight: 500;
      }
      table {
        width: 100%;
      }
    `,
  ],
})
export class SystemExecution {
  readonly execution = input.required<ExecutionStats>();

  protected readonly slipColumns = ['tag', 'fills', 'slip'];
  protected readonly entryColumns = ['tag', 'trades', 'win', 'net'];
  protected readonly Number = Number;
  protected readonly money = (v: string): string => formatMoney(v, 'RUB');
  protected readonly cls = pnlColorClass;
}
