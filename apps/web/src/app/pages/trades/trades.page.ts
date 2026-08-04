import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatTabsModule } from '@angular/material/tabs';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { StateMessage } from '@web-shared';
import { OperationApi } from '../../entities/operation/operation.api';
import { ReferenceApi } from '../../entities/reference/reference.api';
import { TradeApi } from '../../entities/trade/trade.api';
import { TradesTable } from '../../widgets/trades-table/trades-table';
import { TradeStats, type TradeStatRow } from '../../widgets/trade-stats/trade-stats';

/**
 * Страница «Сделки» (docs/03-ux-plan.md, шаг 2). Только просмотр — сделки не
 * хранятся, их целиком пересобирает движок (@core: calculateTrades) из журнала.
 *
 * Три таба: открытые, закрытые и статистика эффективности стратегии. Страница
 * отвечает за фильтр и раскладку, списки и статистика — виджеты; два экземпляра
 * app-trades-table дают независимые сортировку и страницу даром, тогда как раньше
 * страница вела по паре сигналов на каждый список и раздавала их через
 * ngTemplateOutlet-контекст.
 */
@Component({
  selector: 'app-trades-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatTabsModule,
    MatFormFieldModule,
    MatSelectModule,
    StateMessage,
    TradesTable,
    TradeStats,
  ],
  template: `
    <h1 class="page-title">Сделки</h1>

    @if (tradeApi.trades.error()) {
      <app-state-message
        kind="error"
        title="Не удалось загрузить сделки"
        hint="Проверьте, что сервер запущен, и попробуйте ещё раз."
        retryLabel="Повторить"
        (retry)="api.reload()"
      />
    } @else if (tradeApi.trades.hasValue()) {
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
          ng-template matTabContent вокруг тела каждого таба — не украшение:
          инлайновое содержимое Material строит СРАЗУ у всех табов, то есть обе
          таблицы сделок и весь блок статистики оказывались в DOM, даже когда
          открыт один таб. С matTabContent тело создаётся при первом переходе.
        -->
        <mat-tab [label]="'Открытые (' + openTrades().length + ')'">
          <ng-template matTabContent>
            <app-trades-table [trades]="openTrades()" [operations]="operations()" />
          </ng-template>
        </mat-tab>
        <mat-tab [label]="'Закрытые (' + closedTrades().length + ')'">
          <ng-template matTabContent>
            <app-trades-table [trades]="closedTrades()" [operations]="operations()" />
          </ng-template>
        </mat-tab>
        <mat-tab label="Статистика">
          <ng-template matTabContent>
            <div class="stats-tab-content">
              <app-trade-stats
                [trades]="statInputs()"
                [systemNames]="systemNames()"
                [portfolioNames]="portfolioNames()"
              />
            </div>
          </ng-template>
        </mat-tab>
      </mat-tab-group>
    }
  `,
  styles: [
    `
      /* .filters — глобальный (styles.scss) */
      .filters {
        margin-bottom: 12px;
      }
      .stats-tab-content {
        padding-top: 12px;
      }
    `,
  ],
})
export class TradesPage {
  protected readonly api = inject(OperationApi);
  protected readonly tradeApi = inject(TradeApi);
  protected readonly reference = inject(ReferenceApi);

  /** Фильтр по портфелю — сужает и списки сделок, и статистику */
  protected readonly portfolioFilter = signal<string | null>(null);

  private readonly trades = computed(() => {
    const portfolio = this.portfolioFilter();
    const all = this.tradeApi.trades.value() ?? [];
    return portfolio ? all.filter((t) => t.portfolioId === portfolio) : all;
  });

  protected readonly operations = computed(() => this.api.operations.value() ?? []);

  protected readonly openTrades = computed(() =>
    this.trades().filter((t) => t.status !== 'Closed'),
  );
  protected readonly closedTrades = computed(() =>
    this.trades().filter((t) => t.status === 'Closed'),
  );

  /**
   * Вход статистики: минимальные поля сделки, реализ. P&L строкой → числом.
   * Фильтр портфеля применяется И ЗДЕСЬ (изменение поведения, 2026-08-04): читающий
   * макет с фильтром над всеми табами ждёт «win rate по портфелю X», а не «по всему».
   */
  protected readonly statInputs = computed<TradeStatRow[]>(() =>
    this.trades().map((t) => ({
      systemId: t.systemId,
      portfolioId: t.portfolioId,
      status: t.status,
      realizedPnlRub: Number(t.realizedPnlRub),
      openedAt: t.openedAt,
      closedAt: t.closedAt,
    })),
  );

  protected readonly systemNames = computed(
    () => new Map((this.reference.systems.value() ?? []).map((s) => [s.id, s.name])),
  );
  protected readonly portfolioNames = computed(
    () => new Map((this.reference.portfolios.value() ?? []).map((p) => [p.id, p.name])),
  );
}
