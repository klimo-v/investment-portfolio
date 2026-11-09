import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { Cash, Effectiveness, PeriodPerformanceDto } from '@core';
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
 * заработано и какой ценой (результат, TWR, доходность денег, просадка).
 *
 * Абсолютный результат намеренно соседствует с относительными метриками: по одним рублям
 * нельзя понять, хорошо это или плохо (docs/05-review-usability.md §1).
 */
@Component({
  selector: 'app-summary-kpis',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, KpiCard, Hint],
  template: `
    <div class="kpi-grid">
      @if (!systemScoped()) {
        <app-kpi-card
          label="Всего в портфеле"
          [value]="money(cash().totalValueRub)"
          hint="Сколько сейчас в портфеле всего: рыночная стоимость открытых позиций плюс свободные деньги. Не зависит от выбранного периода — это величина на сегодня, а не за окно."
        />
      }
      <app-kpi-card
        label="Позиции"
        [value]="money(totals().currentValueRub)"
        hint="Рыночная стоимость открытых позиций по последним известным ценам. Деньги на счёте сюда не входят — они в соседней карточке."
      />
      @if (!systemScoped()) {
        <app-kpi-card
          label="Свободные деньги"
          [value]="money(cash().cashRub)"
          [tone]="cashIncomplete() ? 'negative' : 'neutral'"
          [sub]="cashIncomplete() ? 'журнал неполон' : ''"
          hint="Остаток на счёте по журналу: пополнения − выводы − покупки + продажи + дивиденды и купоны − налоги и комиссии. Минус означает, что в журнал попали не все движения денег (пополнения, переводы между счетами, отдельные налоги/комиссии) — либо позиции набирались с плечом."
        />
      }
      <app-kpi-card
        label="Вложено"
        [value]="money(totals().investedRub)"
        hint="Себестоимость держимого остатка — сходится с колонкой «Вложено» на странице «Сделки»"
      />

      <!--
        Единственная карточка с ручной разметкой: подстрока несёт ТРИ значения со своими
        знаками (реализ., выплаты, переоценка), а строковый вход sub покрасить их не может.
        Ради одного случая усложнять app-kpi-card проекцией контента не стали.
      -->
      <mat-card class="kpi-manual">
        <mat-card-subtitle>Результат за период <app-hint [text]="resultHint" label="Результат за период" /></mat-card-subtitle>
        <mat-card-title [class]="cls(resultRub())">{{ money(resultRub()) }}</mat-card-title>
        <div class="sub">
          @if (dataWarnings() > 0) {
            <div class="warn">⚠ период задет предупреждениями о данных ({{ dataWarnings() }})</div>
          }
          @if (performance(); as p) {
            @if (p.breakdown.realizedRub !== null && p.breakdown.payoutsRub !== null) {
              реализ.
              <span [class]="cls(num(p.breakdown.realizedRub))">{{ money(num(p.breakdown.realizedRub)) }}</span>
              · выплаты
              <span [class]="cls(num(p.breakdown.payoutsRub))">{{ money(num(p.breakdown.payoutsRub)) }}</span>
            } @else {
              реализ. + выплаты
              <span [class]="cls(num(p.breakdown.fixedRub))">{{ money(num(p.breakdown.fixedRub)) }}</span>
            }
            · переоценка
            <span [class]="cls(num(p.breakdown.revaluationRub))">{{ money(num(p.breakdown.revaluationRub)) }}</span>
          }
        </div>
      </mat-card>

      <app-kpi-card
        label="Доходность стратегии (TWR)"
        [value]="pct(performance()?.twr?.pct ?? null)"
        [tone]="tone(performance()?.twr?.pct ?? null)"
        [sub]="withWarning(performance()?.twr?.pct == null ? noMetric(performance()?.twr?.reason) : '= график «Портфель против рынка»')"
        hint="Time-weighted return: насколько хорошо работал капитал независимо от того, когда вы вносили и выводили деньги. Сравнима с индексом рынка. Совпадает с последней точкой линии «Портфель» на графике «Портфель против рынка»."
      />
      <app-kpi-card
        [label]="moneyReturnLabel()"
        [value]="pct(performance()?.mwr?.pct ?? null)"
        [tone]="tone(performance()?.mwr?.pct ?? null)"
        [sub]="withWarning(performance()?.mwr?.pct == null ? noMetric(performance()?.mwr?.reason) : '')"
        [hint]="moneyReturnHint()"
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
      .warn {
        color: var(--app-warning, #b26a00);
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
  /** Единый расчёт периода (GET /api/performance); undefined — ещё грузится */
  readonly performance = input<PeriodPerformanceDto | undefined>(undefined);
  /** Сколько предупреждений о данных задевает период: карточки помечаются, но не блокируются */
  readonly dataWarnings = input(0);
  /**
   * Выбрана система. Деньги лежат на счёте брокера, а не на системе: пополнения и выводы
   * не привязаны к системам, поэтому «Свободные деньги» и «Всего в портфеле» в срезе системы
   * бессмысленны (минус — не неполный журнал, а отсутствие пополнений у системы).
   */
  readonly systemScoped = input(false);
  /** Просадка в процентах; null — меньше двух дней, считать не из чего */
  readonly drawdownPct = input<number | null>(null);

  /**
   * Остаток ушёл в минус — значит журнал не содержит части денежных движений
   * (libs/core/cash.ts). Подписываем это прямо на карточке, а не прячем: минус
   * здесь информативнее пустого места.
   */
  protected readonly cashIncomplete = computed(() => this.cash().cashRub < 0);

  protected readonly resultHint =
    'Сколько вы заработали ЗА выбранный период: изменение стоимости портфеля минус внесённые деньги. ' +
    'Реализ. — продажи внутри периода, выплаты — дивиденды и купоны, переоценка — изменение стоимости ' +
    'остатка именно за период (прибыль, заработанная до его начала, сюда не входит).';

  protected readonly resultRub = computed(() => Number(this.performance()?.resultRub ?? 0));

  /** Годовые для периода от года, иначе доходность за период — правило задаёт core (mwr.kind) */
  protected readonly moneyReturnLabel = computed(() =>
    this.performance()?.mwr.kind === 'annual' ? 'Доходность ваших денег, % годовых (XIRR)' : 'Доходность ваших денег за период',
  );
  protected readonly moneyReturnHint = computed(() =>
    (this.performance()?.mwr.kind === 'annual'
      ? 'Денежно-взвешенная годовая доходность (XIRR): учитывает суммы и даты ваших вводов и выводов, а капитал на начало периода берётся по рыночной стоимости.'
      : 'Результат за период, делённый на средний капитал периода (с учётом того, сколько времени работал каждый ввод). Короче года в годовые не пересчитываем — аннуализация даёт шум.') +
    ' Может законно отличаться от TWR: если крупный ввод пришёлся перед ростом или падением, ваши деньги отработали иначе, чем стратегия.',
  );

  /** Подпись карточки плюс пометка, если период задевают предупреждения о данных */
  protected withWarning(sub: string): string {
    const mark = this.dataWarnings() > 0 ? `⚠ данные неполны (${this.dataWarnings()})` : '';
    return [sub, mark].filter(Boolean).join(' · ');
  }

  protected num(v: string): number {
    return Number(v);
  }

  protected noMetric(reason: string | null | undefined): string {
    switch (reason) {
      case 'no-capital':
        return 'нет капитала за период';
      case 'negative-capital':
        return 'капитал уходил в минус — журнал неполон (нет пополнения или перевода)';
      case 'xirr-undefined':
        return 'не определена для этих потоков';
      case 'no-data':
        return 'в выбранном периоде нет данных';
      default:
        return '';
    }
  }

  protected readonly money = formatRub;
  protected readonly pct = formatPercentOrDash;
  protected readonly cls = pnlColorClass;
  protected readonly tone = toneOf;
}
