import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { tradeStats, type TradeStats as Stats, type TradeStatInput } from '@core';
import { formatRub, KpiCard, pnlColorClass, StateMessage, toneOf } from '@web-shared';

/** Сделка в разрезе: минимум полей для статистики плюс принадлежность */
export interface TradeStatRow extends TradeStatInput {
  systemId: string;
  portfolioId: string;
}

interface StatsRow extends Stats {
  id: string;
  name: string;
}

/** Разрез статистики */
type GroupBy = 'system' | 'portfolio';

/**
 * Статистика эффективности стратегии по ЗАКРЫТЫМ сделкам
 * (docs/05-review-usability.md §1.3): win rate, profit factor, средний выигрыш и
 * убыток, матожидание, средний срок удержания.
 *
 * Только закрытые — намеренно: открытая позиция ещё не результат, включать её в
 * win rate значило бы считать бумажную переоценку зафиксированной прибылью.
 */
@Component({
  selector: 'app-trade-stats',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatTableModule, MatButtonToggleModule, KpiCard, StateMessage],
  template: `
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
          <app-kpi-card label="Ср. выигрыш" [value]="money(overall().avgWinRub)" tone="positive" />
          <app-kpi-card label="Ср. убыток" [value]="money(overall().avgLossRub)" tone="negative" />
          <app-kpi-card
            label="Матожидание"
            [value]="money(overall().expectancyRub)"
            [tone]="tone(overall().expectancyRub)"
          />
          <app-kpi-card label="Ср. срок" [value]="overall().avgHoldingDays.toFixed(0) + ' дн.'" />
        </div>

        <mat-button-toggle-group
          class="stats-group-toggle"
          [value]="groupBy()"
          (change)="groupBy.set($event.value)"
          hideSingleSelectionIndicator
        >
          <mat-button-toggle value="system">По системам</mat-button-toggle>
          <mat-button-toggle value="portfolio">По портфелям</mat-button-toggle>
        </mat-button-toggle-group>

        @if (rows().length > 1) {
          <table mat-table [dataSource]="rows()" class="stats-table">
            <ng-container matColumnDef="name">
              <th mat-header-cell *matHeaderCellDef>{{ nameLabel() }}</th>
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
              <td mat-cell *matCellDef="let r" [class]="cls(r.expectancyRub)">
                {{ money(r.expectancyRub) }}
              </td>
            </ng-container>
            <ng-container matColumnDef="hold">
              <th mat-header-cell *matHeaderCellDef>Ср. срок</th>
              <td mat-cell *matCellDef="let r">{{ r.avgHoldingDays.toFixed(0) }} дн.</td>
            </ng-container>
            <tr mat-header-row *matHeaderRowDef="columns"></tr>
            <tr mat-row *matRowDef="let row; columns: columns"></tr>
          </table>
        } @else {
          <p class="muted stats-note">
            @if (groupBy() === 'system') {
              Недостаточно систем для разреза (нужно больше одной).
            } @else {
              Недостаточно портфелей для разреза (нужно больше одного).
            }
          </p>
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
  `,
  styles: [
    `
      .stats {
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
      .stats-group-toggle {
        margin-top: 12px;
      }
      .stats-note {
        margin: 12px 0 0;
      }
      /* .kpi-grid, .pnl-* — глобальные (styles.scss) */
      .stats-table {
        width: 100%;
        margin-top: 16px;
      }
    `,
  ],
})
export class TradeStats {
  readonly trades = input<readonly TradeStatRow[]>([]);
  /** id → название системы */
  readonly systemNames = input<ReadonlyMap<string, string>>(new Map());
  /** id → название портфеля */
  readonly portfolioNames = input<ReadonlyMap<string, string>>(new Map());

  protected readonly columns = [
    'name',
    'count',
    'winrate',
    'pf',
    'avgwin',
    'avgloss',
    'expectancy',
    'hold',
  ];

  protected readonly groupBy = signal<GroupBy>('system');

  protected readonly overall = computed<Stats>(() => tradeStats([...this.trades()]));

  protected readonly nameLabel = computed(() =>
    this.groupBy() === 'system' ? 'Система' : 'Портфель',
  );

  /**
   * Разрез по выбранному признаку, по убыванию числа сделок. Строки без закрытых
   * сделок отбрасываются: win rate «0 из 0» не значит ничего, но занимает место.
   */
  protected readonly rows = computed<StatsRow[]>(() => {
    const bySystem = this.groupBy() === 'system';
    const names = bySystem ? this.systemNames() : this.portfolioNames();

    const byId = new Map<string, TradeStatRow[]>();
    for (const t of this.trades()) {
      const key = bySystem ? t.systemId : t.portfolioId;
      const bucket = byId.get(key) ?? [];
      bucket.push(t);
      byId.set(key, bucket);
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
  protected readonly cls = pnlColorClass;
}
