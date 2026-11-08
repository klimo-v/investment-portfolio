import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { PerformanceDto } from '@core';

type Warning = PerformanceDto['warnings'][number];
type Carried = PerformanceDto['carried'][number];

/**
 * «Данные: N предупреждений» — единое место для всего, что делает цифры дашборда неточными:
 * пропуски журнала (купон по графику биржи есть, а операции нет; кэш ушёл в минус — не хватает
 * ввода денег) и дыры в истории цен (цена на конец периода не найдена или взята от более ранней
 * даты). Метрики это не блокирует, но список позволяет увидеть, чему верить с оговоркой.
 * Презентационный виджет (FSD): расчёт — на бэке (libs/core/journal-completeness.ts).
 */
@Component({
  selector: 'app-data-quality',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (total() === 0) {
      <p class="ok">Данные: предупреждений нет</p>
    } @else {
      <details class="dq" [open]="false">
        <summary [class.touches]="inPeriod() > 0">
          Данные: {{ total() }} {{ plural(total()) }}
          @if (inPeriod() > 0) {
            <span class="badge">задевают выбранный период: {{ inPeriod() }}</span>
          }
        </summary>
        <ul>
          @for (w of warnings(); track w.kind + w.date + (w.instrumentId ?? '')) {
            <li [class.out]="!w.inPeriod">
              {{ w.message }}
              @if (!w.inPeriod) {
                <span class="muted"> (вне выбранного периода)</span>
              }
            </li>
          }
          @for (c of carried(); track c.instrumentId) {
            <li>{{ carriedText(c) }}</li>
          }
        </ul>
      </details>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        margin-bottom: 12px;
      }
      .ok {
        margin: 0;
        font-size: 13px;
        color: var(--app-text-muted);
      }
      .dq summary {
        cursor: pointer;
        font-size: 14px;
      }
      .dq summary.touches {
        color: var(--app-warning, #b26a00);
      }
      .badge {
        margin-left: 8px;
        font-size: 12px;
        padding: 1px 8px;
        border-radius: 10px;
        background: var(--app-warning-bg, rgba(224, 164, 0, 0.18));
      }
      ul {
        margin: 8px 0 0;
        padding-left: 20px;
        font-size: 13px;
      }
      li {
        margin-bottom: 4px;
      }
      .out,
      .muted {
        color: var(--app-text-muted);
      }
    `,
  ],
})
export class DataQuality {
  readonly warnings = input<readonly Warning[]>([]);
  readonly carried = input<readonly Carried[]>([]);

  protected readonly total = computed(() => this.warnings().length + this.carried().length);
  /** Сколько из них задевает выбранный период; пометки цен относятся к концу периода — всегда задевают */
  protected readonly inPeriod = computed(() => this.warnings().filter((w) => w.inPeriod).length + this.carried().length);

  protected plural(n: number): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'предупреждение';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'предупреждения';
    return 'предупреждений';
  }

  protected carriedText(c: Carried): string {
    return c.reason === 'no-price'
      ? `${c.ticker}: цена на конец периода не найдена, оценено по себестоимости — стоимость и результат приблизительны.`
      : c.reason === 'no-fx'
        ? `${c.ticker}: нет курса валюты цены, оценено по себестоимости — стоимость и результат приблизительны.`
        : `${c.ticker}: цена на конец периода взята от ${c.priceDate} — стоимость может отставать от рынка.`;
  }
}
