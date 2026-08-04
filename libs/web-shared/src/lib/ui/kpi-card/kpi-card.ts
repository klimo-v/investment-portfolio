import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { Hint } from '../hint/hint';

/** Знак результата — красит значение; 'neutral' оставляет цвет текста как есть */
export type KpiTone = 'neutral' | 'positive' | 'negative';

/**
 * Карточка ключевого показателя. Сводит три разошедшиеся реализации одного и того же:
 * `.totals` дашборда (7 карточек), `.totals` портфеля (4) и `.kpis/.kpi` «Сделок» (7) —
 * они отличались размерами, отступами и цветом подписи без всякой причины.
 *
 * Контейнером НЕ занимается: ряд карточек задаётся глобальным классом `.kpi-grid`
 * (styles.scss). Обёртка-компонент добавила бы уровень DOM и возню с
 * `:host { display: grid }` ради нуля.
 */
@Component({
  selector: 'app-kpi-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, Hint],
  template: `
    <mat-card>
      <mat-card-subtitle>
        {{ label() }}
        @if (hint()) {
          <app-hint [text]="hint()" [label]="label()" />
        }
      </mat-card-subtitle>
      <mat-card-title [class]="toneClass()">{{ value() }}</mat-card-title>
      @if (sub()) {
        <div class="sub">{{ sub() }}</div>
      }
    </mat-card>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      mat-card {
        padding: 16px;
        height: 100%;
        box-sizing: border-box;
      }
      .sub {
        margin-top: 4px;
        font-size: 12px;
        color: var(--app-text-muted);
      }
    `,
  ],
})
export class KpiCard {
  /** Название показателя («Вложено», «XIRR») */
  readonly label = input.required<string>();
  /** Уже отформатированное значение — форматирование остаётся на стороне страницы */
  readonly value = input.required<string>();
  /** Пояснение к показателю; пусто — бейдж «?» не рисуется */
  readonly hint = input('');
  /** Мелкая строка под значением (разбивка, вторичная метрика) */
  readonly sub = input('');
  readonly tone = input<KpiTone>('neutral');

  /**
   * Отображаем в СУЩЕСТВУЮЩИЕ глобальные классы (styles.scss), а не в `pnl-${tone}`:
   * нейтральный тон там называется `pnl-zero`, и наивная склейка дала бы несуществующий
   * `pnl-neutral` — значение молча осталось бы без правила.
   */
  protected readonly toneClass = computed(
    () =>
      ({ neutral: 'pnl-zero', positive: 'pnl-positive', negative: 'pnl-negative' })[this.tone()],
  );
}
