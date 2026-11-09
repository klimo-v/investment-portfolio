import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';

/**
 * Подсказка начала TWR. TWR честно считает доходность и ничтожного остатка (2 ₽ на курсе юаня),
 * но к деньгам счёта она отношения не имеет и даёт пугающие просадки. Виджет называет дату, с которой
 * капитал стал значимым, и предлагает начать период с неё. Расчёт от подсказки не зависит —
 * решает пользователь.
 */
@Component({
  selector: 'app-twr-start-hint',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatButtonModule, DatePipe],
  template: `
    @if (visible()) {
      <mat-card class="hint">
        <span>
          До <b>{{ suggestedFrom() | date: 'dd.MM.yyyy' }}</b> на счёте почти не было капитала (менее 0,1% от максимума).
          Доходность (TWR) и просадка за этот отрезок считают ничтожный остаток и не показательны для ваших денег.
        </span>
        <button mat-stroked-button (click)="apply.emit(suggestedFrom()!)">
          Считать с {{ suggestedFrom() | date: 'dd.MM.yyyy' }}
        </button>
      </mat-card>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .hint {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px;
        justify-content: space-between;
        padding: 12px 16px;
        margin-bottom: 16px;
        color: var(--app-warning, #b26a00);
      }
    `,
  ],
})
export class TwrStartHint {
  /** Дата начала значимого капитала из расчёта (twrSuggestedFrom); null — подсказывать нечего */
  readonly suggestedFrom = input<string | null>(null);
  /** Начало уже выбранного периода: если он и так начинается не раньше подсказки, виджет скрыт */
  readonly currentFrom = input<string | null>(null);
  readonly apply = output<string>();

  protected readonly visible = computed(() => {
    const s = this.suggestedFrom();
    const c = this.currentFrom();
    return !!s && (c === null || c < s);
  });
}
