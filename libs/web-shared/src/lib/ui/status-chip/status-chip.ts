import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Смысл статуса; цвета берутся из токенов --app-chip-* (styles.scss) */
export type ChipTone = 'success' | 'warn' | 'danger' | 'info' | 'neutral';

/**
 * Компактная плашка статуса. Сводит две несвязанные реализации одного и того же:
 * `.status-open/.status-partial/.status-closed` на «Сделках» и `.chip.ok/.warn/.dup/.err`
 * на «Импорте» — обе с собственными наборами захардкоженных пар цветов.
 *
 * Не `mat-chip`: тот тащит интерактивные аффордансы (ripple, фокус, кнопка удаления)
 * и min-height 32px, которых здесь нет и не нужно, а перетемизация его MDC-токенов
 * дороже восьми строк CSS.
 *
 * Текст статуса идёт через <ng-content> и остаётся в потоке чтения: цвет здесь —
 * дополнение к слову, а не единственный носитель смысла (WCAG 1.4.1).
 */
@Component({
  selector: 'app-status-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="chip" [class]="'chip--' + tone()"><ng-content /></span>`,
  styles: [
    `
      :host {
        display: inline-flex;
      }
      .chip {
        padding: 2px 10px;
        border-radius: 12px;
        font-size: 12px;
        white-space: nowrap;
      }
      .chip--success {
        background: var(--app-chip-success-bg);
        color: var(--app-chip-success-fg);
      }
      .chip--warn {
        background: var(--app-chip-warn-bg);
        color: var(--app-chip-warn-fg);
      }
      .chip--danger {
        background: var(--app-chip-danger-bg);
        color: var(--app-chip-danger-fg);
      }
      .chip--info {
        background: var(--app-chip-info-bg);
        color: var(--app-chip-info-fg);
      }
      .chip--neutral {
        background: var(--app-chip-neutral-bg);
        color: var(--app-chip-neutral-fg);
      }
    `,
  ],
})
export class StatusChip {
  readonly tone = input<ChipTone>('neutral');
}
