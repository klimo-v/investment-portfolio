import { ChangeDetectionStrategy, Component, effect, signal } from '@angular/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { DateAdapter, MAT_DATE_LOCALE } from '@angular/material/core';
import { StrictDateAdapter } from './strict-date-adapter';
import { toIsoDate } from '../../shared/iso-date';
import { Hint } from '@web-shared';
import { ReferenceApi } from '../../entities/reference/reference.api';
import { inject } from '@angular/core';
import { dashboardFilter } from './dashboard-filter.state';

/**
 * Ряд фильтров дашборда: система, портфель, период (+ произвольный диапазон).
 *
 * Наружу ничего не отдаёт и ничего не принимает: состояние лежит в query-параметрах,
 * и страница читает его тем же `dashboardFilter()`. Двусторонний биндинг с
 * родителем тут был бы лишним звеном — источник истины всё равно URL.
 */
@Component({
  selector: 'app-dashboard-filters',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    { provide: DateAdapter, useClass: StrictDateAdapter },
    { provide: MAT_DATE_LOCALE, useValue: 'ru-RU' },
  ],
  imports: [MatButtonToggleModule, MatFormFieldModule, MatSelectModule, MatDatepickerModule, Hint],
  template: `
    <div class="filters">
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Система</mat-label>
        <mat-select [value]="filter.system()" (selectionChange)="filter.setSystem($event.value)">
          <mat-option [value]="null">Все</mat-option>
          @for (s of reference.systems.value(); track s.id) {
            <mat-option [value]="s.id">{{ s.name }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Портфель</mat-label>
        <mat-select
          [value]="filter.portfolio()"
          (selectionChange)="filter.setPortfolio($event.value)"
        >
          <mat-option [value]="null">Все</mat-option>
          @for (p of reference.portfolios.value(); track p.id) {
            <mat-option [value]="p.id">{{ p.name }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-button-toggle-group
        [value]="filter.period()"
        (change)="filter.setPeriod($event.value)"
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
        text="Период сужает окно: Результат, TWR, доходность денег и помесячный график считаются именно за выбранный отрезок — прибыль, заработанная до его начала, в них не входит (капитал на начало берётся по рыночной стоимости). Вложено, Стоимость и свободные деньги — состояние на конец выбранного периода. Если период короче года, доходность денег показывается за период, а не в годовых."
      />
      @if (filter.period() === 'custom') {
        <mat-form-field appearance="outline" subscriptSizing="dynamic" class="range-field">
          <mat-label>Диапазон</mat-label>
          <mat-date-range-input [rangePicker]="customPicker">
            <input
              matStartDate
              placeholder="От"
              [value]="filter.customFrom()"
              (input)="setText('from', $event)"
              (dateInput)="setDate('from', $event.value, $event.targetElement)"
            />
            <input
              matEndDate
              placeholder="До"
              [value]="filter.customTill()"
              (input)="setText('till', $event)"
              (dateInput)="setDate('till', $event.value, $event.targetElement)"
            />
          </mat-date-range-input>
          <mat-datepicker-toggle matIconSuffix [for]="customPicker"></mat-datepicker-toggle>
          <mat-date-range-picker #customPicker></mat-date-range-picker>
        </mat-form-field>
        @if (filter.error(); as error) {
          <p class="range-error" role="alert">{{ error }}</p>
        } @else if (!filter.ready() && !filter.calendarError() && !filter.calendarLoading()) {
          <p class="range-error">Укажите обе даты периода.</p>
        }
      }
    </div>
  `,
  styles: [
    `
      /* .filters — глобальный (styles.scss): переносится, поля тянутся */
      .filters {
        max-width: 100%;
        min-width: 0;
      }
      mat-button-toggle-group {
        flex-wrap: wrap;
        max-width: 100%;
      }
      /* 40px icon button has a 48px touch target: reserve its 4px overhang. */
      mat-datepicker-toggle {
        margin-inline-end: 4px;
      }
      .range-error {
        color: var(--app-warning, #b26a00);
        margin: 0;
      }
      :host {
        display: contents;
      }
    `,
  ],
})
export class DashboardFilters {
  protected readonly reference = inject(ReferenceApi);
  protected readonly filter = dashboardFilter();
  private readonly dates = inject<DateAdapter<Date>>(DateAdapter);
  private readonly draftFrom = signal<string | null>(null);
  private readonly draftTill = signal<string | null>(null);
  constructor() {
    effect(() => {
      this.draftFrom.set(this.filter.rawFrom());
      this.draftTill.set(this.filter.rawTill());
    });
  }
  // Material dateInput only emits when its parsed Date changes. Invalid text
  // typed into an empty field stays null, so always inspect the native input.
  protected setText(side: 'from' | 'till', event: Event): void {
    const input = event.target as HTMLInputElement;
    this.setDate(side, this.dates.parse(input.value, null), input);
  }
  protected setDate(side: 'from' | 'till', date: Date | null, element: HTMLElement): void {
    const raw = (element as HTMLInputElement).value;
    const value = date && !Number.isNaN(date.getTime()) ? toIsoDate(date) : raw.trim() || null;
    const draft = side === 'from' ? this.draftFrom : this.draftTill;
    if (draft() === value) return;
    draft.set(value);
    this.filter.setRawRange(this.draftFrom(), this.draftTill());
  }
}
