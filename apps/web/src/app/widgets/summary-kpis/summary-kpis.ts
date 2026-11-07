import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { Cash, Effectiveness } from '@core';
import {
  formatPercentOrDash,
  formatRub,
  Hint,
  KpiCard,
  pnlColorClass,
  toneOf,
} from '@web-shared';

/**
 * Ряд ключевых показателей дашборда: сколько всего, из чего состоит, сколько
 * заработано и какой ценой (ROI, XIRR, просадка).
 *
 * Абсолютный P&L намеренно соседствует с относительными метриками: по одним рублям
 * нельзя понять, хорошо это или плохо (docs/05-review-usability.md §1).
 */
@Component({
  selector: 'app-summary-kpis',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, KpiCard, Hint],
  template: `
    <div class="kpi-grid">
      <app-kpi-card
        label="Всего в портфеле"
        [value]="money(cash().totalValueRub)"
        hint="Сколько сейчас в портфеле всего: рыночная стоимость открытых позиций плюс свободные деньги. Не зависит от выбранного периода — это величина на сегодня, а не за окно."
      />
      <app-kpi-card
        label="Позиции"
        [value]="money(totals().currentValueRub)"
        hint="Рыночная стоимость открытых позиций по последним известным ценам. Деньги на счёте сюда не входят — они в соседней карточке."
      />
      <app-kpi-card
        label="Свободные деньги"
        [value]="money(cash().cashRub)"
        [tone]="cashIncomplete() ? 'negative' : 'neutral'"
        [sub]="cashIncomplete() ? 'журнал неполон' : ''"
        hint="Остаток на счёте по журналу: пополнения − выводы − покупки + продажи + дивиденды и купоны − налоги и комиссии. Минус означает, что в журнал попали не все движения денег (пополнения, переводы между счетами, отдельные налоги/комиссии) — либо позиции набирались с плечом."
      />
      <app-kpi-card
        label="Вложено"
        [value]="money(totals().investedRub)"
        hint="Себестоимость держимого остатка — сходится с колонкой «Вложено» на странице «Сделки»"
      />

      <!--
        Единственная карточка с ручной разметкой: подстрока несёт ДВА значения со
        своими знаками (реализ./нереализ.), а строковый вход sub покрасить их не
        может. Ради одного случая усложнять app-kpi-card проекцией контента не стали.
      -->
      <mat-card class="kpi-manual">
        <mat-card-subtitle>P&L <app-hint [text]="pnlHint()" label="P&L" /></mat-card-subtitle>
        <mat-card-title [class]="cls(totals().pnlRub)">{{ money(totals().pnlRub) }}</mat-card-title>
        <div class="sub">
          реализ.
          <span [class]="cls(totals().realizedPnlRub)">{{ money(totals().realizedPnlRub) }}</span>
          · нереализ.
          <span [class]="cls(totals().unrealizedPnlRub)">{{ money(totals().unrealizedPnlRub) }}</span>
        </div>
      </mat-card>

      <app-kpi-card
        label="ROI"
        [value]="pct(totals().roiPct)"
        [tone]="tone(totals().roiPct)"
        hint="P&L относительно вложенного (себестоимости держимого остатка). Фьючерсы не входят: вложений у них нет."
      />
      <app-kpi-card
        label="Доходность годовых (XIRR)"
        [value]="pct(totals().xirrPct)"
        [tone]="tone(totals().xirrPct)"
        hint="Денежно-взвешенная годовая доходность с учётом дат вложений. Фьючерсы не входят."
      />
      <app-kpi-card
        label="Дивиденды + купоны"
        [value]="money(totals().dividendsRub)"
        [sub]="'доходность ' + pct(totals().dividendYieldPct)"
      />
      <app-kpi-card
        label="Макс. просадка"
        [value]="drawdownPct() === null ? '—' : pct(drawdownPct())"
        [tone]="tone(drawdownPct())"
        hint="Наибольшее падение доходности портфеля от пика к дну; ввод и вывод денег и продажи на неё не влияют"
      />
    </div>
  `,
  styles: [
    `
      /* .kpi-grid — глобальный (styles.scss) */
      :host {
        display: contents;
      }
      /* Ручная карточка внутри .kpi-grid — повторяет геометрию app-kpi-card */
      .kpi-manual {
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
export class SummaryKpis {
  readonly totals = input.required<Effectiveness>();
  readonly cash = input.required<Cash>();
  /** Просадка в процентах; null — меньше двух дней, считать не из чего */
  readonly drawdownPct = input<number | null>(null);
  readonly pnlHint = input('');

  /**
   * Остаток ушёл в минус — значит журнал не содержит части денежных движений
   * (libs/core/cash.ts). Подписываем это прямо на карточке, а не прячем: минус
   * здесь информативнее пустого места.
   */
  protected readonly cashIncomplete = computed(() => this.cash().cashRub < 0);

  protected readonly money = formatRub;
  protected readonly pct = formatPercentOrDash;
  protected readonly cls = pnlColorClass;
  protected readonly tone = toneOf;
}
