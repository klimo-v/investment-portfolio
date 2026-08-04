import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

/** Пустой результат или ошибка загрузки — разный тон и иконка по умолчанию */
export type StateKind = 'error' | 'empty';

/**
 * Сообщение вместо содержимого: «ничего не найдено» или «не удалось загрузить».
 * Сводит пять копий `.empty` и пять `<p class="error">Не удалось загрузить…
 * Запущен ли API?</p>` — последние были откровенно девелоперскими и не давали
 * пользователю ничего сделать.
 *
 * Сознательно НЕ обёртка с <ng-content> вокруг содержимого страницы: контент
 * проецируется РОДИТЕЛЕМ независимо от @if внутри дочернего компонента, поэтому
 * обёртка всё равно инстанцировала бы <canvas baseChart> и mat-table в момент,
 * когда показывать их нечем. Страница оставляет свой @if, а сюда попадает только
 * несчастливая ветка.
 *
 * Сознательно НЕТ варианта 'loading': глобальный mat-progress-bar в тулбаре уже
 * заведён на каждый HTTP-запрос через loadingInterceptor, и локальный индикатор
 * поверх него только мигал бы.
 */
@Component({
  selector: 'app-state-message',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule],
  template: `
    <div class="state" [class.state--error]="kind() === 'error'" role="status">
      <mat-icon class="state-icon">{{ resolvedIcon() }}</mat-icon>
      <p class="state-title">{{ title() }}</p>
      @if (hint()) {
        <p class="state-hint">{{ hint() }}</p>
      }
      @if (retryLabel()) {
        <button mat-stroked-button type="button" (click)="retry.emit()">
          {{ retryLabel() }}
        </button>
      }
    </div>
  `,
  styles: [
    `
      .state {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding: 32px 24px;
        text-align: center;
        color: var(--app-text-muted);
      }
      .state-icon {
        width: 32px;
        height: 32px;
        font-size: 32px;
        opacity: 0.6;
      }
      .state--error .state-icon {
        color: var(--app-danger);
        opacity: 1;
      }
      .state-title {
        margin: 0;
        font-size: 15px;
        color: var(--mat-sys-on-surface);
      }
      .state-hint {
        margin: 0;
        max-width: 46ch;
        font-size: 13px;
      }
    `,
  ],
})
export class StateMessage {
  readonly kind = input.required<StateKind>();
  /** Главная строка — что произошло, человеческим языком */
  readonly title = input.required<string>();
  /** Вторая строка — что с этим делать */
  readonly hint = input('');
  /** Своя иконка; пусто — берётся по kind */
  readonly icon = input('');
  /** Подпись кнопки повтора; пусто — кнопки нет */
  readonly retryLabel = input('');
  readonly retry = output<void>();

  protected readonly resolvedIcon = computed(
    () => this.icon() || (this.kind() === 'error' ? 'error_outline' : 'inbox'),
  );
}
