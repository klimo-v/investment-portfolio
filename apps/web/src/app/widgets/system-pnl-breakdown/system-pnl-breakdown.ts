import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import type { SystemPerformance } from '@core';
import { PnlBarChart, type PnlBar } from '../pnl-bar-chart/pnl-bar-chart';

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const;
type Mode = 'month' | 'weekday';

/** Результат системы по месяцам или дням недели (по дате закрытия сделки) */
@Component({
  selector: 'app-system-pnl-breakdown',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonToggleModule, PnlBarChart],
  template: `
    <mat-button-toggle-group
      class="mode"
      [value]="mode()"
      (change)="mode.set($event.value)"
      hideSingleSelectionIndicator
      aria-label="Разрез результата"
    >
      <mat-button-toggle value="month">По месяцам</mat-button-toggle>
      <mat-button-toggle value="weekday">По дням недели</mat-button-toggle>
    </mat-button-toggle-group>
    <app-pnl-bar-chart
      [title]="mode() === 'month' ? 'Результат по месяцам' : 'Результат по дням недели'"
      [bars]="bars()"
      emptyTitle="Нет закрытых сделок"
      emptyHint="Разрез появится после первой закрытой сделки."
    />
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .mode {
        margin-bottom: 8px;
      }
    `,
  ],
})
export class SystemPnlBreakdown {
  readonly performance = input.required<SystemPerformance>();
  protected readonly mode = signal<Mode>('month');

  protected readonly bars = computed<PnlBar[]>(() => {
    const s = this.performance().series;
    return this.mode() === 'month'
      ? s.byMonth.map((m) => ({ label: m.period, pnlRub: Number(m.pnlRub) }))
      : s.byWeekday.map((w) => ({ label: WEEKDAYS[w.weekday - 1], pnlRub: Number(w.pnlRub) }));
  });
}
