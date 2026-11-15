import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatTabsModule } from '@angular/material/tabs';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { StateMessage } from '@web-shared';
import { TradeApi } from '../../entities/trade/trade.api';
import { ReferenceApi } from '../../entities/reference/reference.api';
import { TradesTable } from '../../widgets/trades-table/trades-table';
import { TradeStats } from '../../widgets/trade-stats/trade-stats';
import { queryParams } from '../../shared/query-param';
import { parseIsoDate } from '../../shared/iso-date';

/** Списки используют один срез; период закрытия не ограничивает открытые сделки. */
@Component({
  selector: 'app-trades-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatTabsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    StateMessage,
    TradesTable,
    TradeStats,
  ],
  template: `
    <h1 class="page-title">Сделки</h1>
    <div class="filters">
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Портфель</mat-label>
        <mat-select [value]="portfolio()" (selectionChange)="set('portfolio', $event.value)">
          <mat-option [value]="null">Все</mat-option>
          @for (p of portfolios(); track p.id) {
            <mat-option [value]="p.id">{{ p.name }}</mat-option>
          }
          @if (portfolio() && !portfolioNames().has(portfolio()!)) {
            <mat-option [value]="portfolio()">{{ portfolio() }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Система</mat-label>
        <mat-select [value]="system()" (selectionChange)="set('system', $event.value)">
          <mat-option [value]="null">Все</mat-option>
          @for (s of systems(); track s.id) {
            <mat-option [value]="s.id">{{ s.name }}</mat-option>
          }
          @if (system() && !systemNames().has(system()!)) {
            <mat-option [value]="system()">{{ system() }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Поиск по инструменту</mat-label>
        <input matInput [value]="search() ?? ''" (input)="text('q', $event)" />
      </mat-form-field>
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Закрыта с</mat-label>
        <input
          matInput
          [value]="from() ?? ''"
          (input)="text('closedFrom', $event)"
          placeholder="2026-01-01"
        />
        <mat-hint>ГГГГ-ММ-ДД</mat-hint>
      </mat-form-field>
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Закрыта по</mat-label>
        <input
          matInput
          [value]="till() ?? ''"
          (input)="text('closedTill', $event)"
          placeholder="2026-12-31"
        />
        <mat-hint>ГГГГ-ММ-ДД</mat-hint>
      </mat-form-field>
      @if (hasFilters()) {
        <button mat-stroked-button (click)="reset()">Сбросить фильтры</button>
      }
    </div>
    @if (dateError()) {
      <p class="error" role="alert">{{ dateError() }}</p>
    }
    @if (
      reference.systems.error() || reference.portfolios.error() || reference.instruments.error()
    ) {
      <p role="status">
        Часть справочника недоступна. Вместо названий показаны доступные идентификаторы.
      </p>
    }
    @if (tradeApi.trades.isLoading()) {
      <p role="status">Загружаем сделки…</p>
    } @else if (tradeApi.trades.error()) {
      <app-state-message
        kind="error"
        title="Не удалось загрузить сделки"
        retryLabel="Повторить"
        (retry)="tradeApi.trades.reload()"
      />
    } @else if (tradeApi.trades.hasValue()) {
      <mat-tab-group
        [selectedIndex]="tabIndex()"
        (selectedIndexChange)="selectTab($event)"
        [preserveContent]="true"
      >
        <mat-tab [label]="'Открытые (' + openTrades().length + ')'">
          <ng-template matTabContent>
            @if (from() || till()) {
              <p>Период закрытия не применяется к открытым сделкам.</p>
            }
            <app-trades-table
              [trades]="openTrades()"
              [(pageSize)]="pageSize"
              [emptyTitle]="emptyTitle()"
            />
          </ng-template>
        </mat-tab>
        <mat-tab [label]="'Закрытые (' + closedTrades().length + ')'">
          <ng-template matTabContent>
            @if (!dateError()) {
              <app-trades-table
                [trades]="closedTrades()"
                [(pageSize)]="pageSize"
                [emptyTitle]="emptyTitle()"
              />
            }
          </ng-template>
        </mat-tab>
        <mat-tab label="Статистика">
          <ng-template matTabContent>
            @if (!dateError()) {
              @if (closedTrades().length > 0) {
                <app-trade-stats
                  [trades]="statInputs()"
                  [systemNames]="systemNames()"
                  [portfolioNames]="portfolioNames()"
                  [systemQueryParams]="systemParams()"
                />
              } @else {
                <app-state-message
                  kind="empty"
                  [title]="
                    filteredStatsEmpty()
                      ? 'Нет закрытых сделок по выбранным фильтрам'
                      : 'Нет закрытых сделок'
                  "
                  [hint]="
                    filteredStatsEmpty()
                      ? 'Измените или сбросьте фильтры.'
                      : 'Статистика считается по торговому результату закрытых сделок после комиссий, без выплат.'
                  "
                  [retryLabel]="filteredStatsEmpty() ? 'Сбросить фильтры' : ''"
                  (retry)="reset()"
                />
              }
            }
          </ng-template>
        </mat-tab>
      </mat-tab-group>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 12px;
      }
      mat-form-field {
        min-width: 0;
        width: 220px;
        max-width: 100%;
      }
    `,
  ],
})
export class TradesPage {
  protected readonly pageSize = signal(25);
  protected readonly tradeApi = inject(TradeApi);
  protected readonly reference = inject(ReferenceApi);
  private readonly params = queryParams();
  protected readonly portfolio = this.params.read('portfolio');
  protected readonly system = this.params.read('system');
  protected readonly search = this.params.read('q');
  protected readonly from = this.params.read('closedFrom');
  protected readonly till = this.params.read('closedTill');
  private readonly tab = this.params.read('tab');
  protected readonly tabIndex = computed(() =>
    this.tab() === 'closed' ? 1 : this.tab() === 'stats' ? 2 : 0,
  );
  protected readonly portfolios = computed(() =>
    this.reference.portfolios.hasValue() ? this.reference.portfolios.value() : [],
  );
  protected readonly systems = computed(() =>
    this.reference.systems.hasValue() ? this.reference.systems.value() : [],
  );
  protected readonly systemNames = computed(
    () => new Map(this.systems().map((s) => [s.id, s.name])),
  );
  protected readonly portfolioNames = computed(
    () => new Map(this.portfolios().map((p) => [p.id, p.name])),
  );
  protected readonly hasFilters = computed(
    () => !!(this.portfolio() || this.system() || this.search() || this.from() || this.till()),
  );
  protected readonly emptyTitle = computed(() =>
    this.hasFilters() ? 'Нет сделок по выбранным фильтрам' : 'Сделок нет',
  );
  protected readonly dateError = computed(() => {
    const from = this.from(),
      till = this.till();
    if ((from && !parseIsoDate(from)) || (till && !parseIsoDate(till)))
      return 'Некорректная или несуществующая дата. Используйте ГГГГ-ММ-ДД.';
    return from && till && from > till
      ? 'Начало периода закрытия должно быть не позже конца.'
      : null;
  });
  private readonly filtered = computed(() => {
    if (!this.tradeApi.trades.hasValue()) return [];
    const q = this.search()?.trim().toLocaleLowerCase();
    const instruments = this.reference.instruments.hasValue()
      ? this.reference.instruments.value()
      : [];
    const names = new Map(instruments.map((i) => [i.id, i.name ?? '']));
    return this.tradeApi.trades
      .value()
      .filter(
        (t) =>
          (!this.portfolio() || t.portfolioId === this.portfolio()) &&
          (!this.system() || t.systemId === this.system()) &&
          (!q ||
            `${t.ticker} ${t.instrumentId} ${names.get(t.instrumentId) ?? ''}`
              .toLocaleLowerCase()
              .includes(q)),
      );
  });
  protected readonly openTrades = computed(() =>
    this.filtered().filter((t) => t.status !== 'Closed'),
  );
  protected readonly closedTrades = computed(() => {
    if (this.dateError()) return [];
    const from = this.from(),
      till = this.till();
    return this.filtered().filter(
      (t) =>
        t.status === 'Closed' &&
        t.closedAt &&
        (!from || t.closedAt >= from) &&
        (!till || t.closedAt <= till),
    );
  });
  protected readonly filteredStatsEmpty = computed(
    () =>
      this.hasFilters() &&
      this.closedTrades().length === 0 &&
      this.tradeApi.trades.hasValue() &&
      this.tradeApi.trades.value().some((t) => t.status === 'Closed'),
  );
  protected readonly statInputs = computed(() =>
    this.closedTrades().map((t) => ({ ...t, realizedPnlRub: Number(t.realizedPnlRub) })),
  );
  // Закрытие сделки и период расчёта системы имеют разный смысл: передаём только портфель.
  protected readonly systemParams = computed(() =>
    this.portfolio() ? { portfolio: this.portfolio() } : {},
  );
  protected set(key: string, value: string | null): void {
    void this.params.patch({ [key]: value });
  }
  protected text(key: string, event: Event): void {
    this.set(key, (event.target as HTMLInputElement).value);
  }
  protected selectTab(index: number): void {
    this.set('tab', ['open', 'closed', 'stats'][index]);
  }
  protected reset(): void {
    void this.params.patch({
      portfolio: null,
      system: null,
      q: null,
      closedFrom: null,
      closedTill: null,
    });
  }
}
