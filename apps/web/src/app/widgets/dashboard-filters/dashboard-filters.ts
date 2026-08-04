import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatDatepickerModule } from '@angular/material/datepicker';
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
        text="Период сужает окно: Реализ./Дивиденды/P&L/ROI/XIRR и помесячный график считаются по операциям ВНУТРИ выбранного отрезка. Вложено/Текущая стоимость/Нереализ. — это состояние текущего остатка, оно не меняется от периода (себестоимость держимого нельзя посчитать иначе, чем по всей истории покупок). На коротком окне XIRR может быть не определён (—) — это статистический шум, а не ошибка."
      />
      @if (filter.period() === 'custom') {
        <mat-form-field appearance="outline" subscriptSizing="dynamic" class="range-field">
          <mat-label>Диапазон</mat-label>
          <mat-date-range-input [rangePicker]="customPicker">
            <input
              matStartDate
              placeholder="От"
              [value]="filter.customFrom()"
              (dateChange)="filter.setCustomFrom($event.value)"
            />
            <input
              matEndDate
              placeholder="До"
              [value]="filter.customTill()"
              (dateChange)="filter.setCustomTill($event.value)"
            />
          </mat-date-range-input>
          <mat-datepicker-toggle matIconSuffix [for]="customPicker"></mat-datepicker-toggle>
          <mat-date-range-picker #customPicker></mat-date-range-picker>
        </mat-form-field>
      }
    </div>
  `,
  styles: [
    `
      /* .filters — глобальный (styles.scss): переносится, поля тянутся */
      :host {
        display: contents;
      }
    `,
  ],
})
export class DashboardFilters {
  protected readonly reference = inject(ReferenceApi);
  protected readonly filter = dashboardFilter();
}
