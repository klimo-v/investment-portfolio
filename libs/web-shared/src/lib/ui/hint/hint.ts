import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';

/**
 * Бейдж-подсказка «?» с пояснением по наведению/фокусу.
 *
 * Заменяет `<span class="hint" matTooltip="…">?</span>`, который был в 12 местах и
 * нёс ЕДИНСТВЕННОЕ в приложении объяснение доменных терминов (XIRR, Вложено,
 * Реализ./Нереализ.) — по 300-450 символов каждое. Проблема была не в дублировании
 * стилей, а в том, что `<span>` недостижим ни с клавиатуры, ни скринридером: без
 * `tabindex`/`role` фокус на него не встаёт, а доступным именем становился сам
 * символ «?».
 *
 * Здесь это настоящая `<button type="button">`: в таб-порядок попадает сама,
 * тултип Material открывается по фокусу через FocusMonitor, а `aria-label` несёт
 * полный текст пояснения — скринридер прочитает его целиком.
 *
 * `type="button"` обязателен: внутри формы кнопка по умолчанию сабмитит её.
 */
@Component({
  selector: 'app-hint',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatTooltipModule],
  template: `
    <button
      type="button"
      class="badge"
      [matTooltip]="text()"
      [attr.aria-label]="label() + ': ' + text()"
      matTooltipTouchGestures="on"
      matTooltipPosition="above"
    >
      ?
    </button>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        vertical-align: middle;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        padding: 0;
        border-radius: 50%;
        border: 1px solid var(--app-text-muted);
        background: transparent;
        color: var(--app-text-muted);
        font: inherit;
        font-size: 10px;
        line-height: 1;
        cursor: help;
      }
      /* Фокус обязан быть видимым: кнопка крошечная, без кольца её не найти табом */
      .badge:focus-visible {
        outline: 2px solid var(--mat-sys-primary);
        outline-offset: 2px;
      }
      .badge:hover {
        color: var(--mat-sys-on-surface);
        border-color: var(--mat-sys-on-surface);
      }
    `,
  ],
})
export class Hint {
  /** Текст пояснения — идёт и в тултип, и в доступное имя */
  readonly text = input.required<string>();
  /**
   * Чему относится пояснение («Вложено», «XIRR»). Попадает в aria-label перед
   * текстом: без этого скринридер зачитает объяснение, не назвав предмет.
   */
  readonly label = input('Подсказка');
}
