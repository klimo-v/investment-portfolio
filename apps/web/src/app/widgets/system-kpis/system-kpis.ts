import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { SystemPerformance } from '@core';
import { formatMoney, KpiCard, toneOf, type KpiTone } from '@web-shared';

/** Срок удержания: точные часы, если у сделок есть время, иначе дни */
export function formatHolding(hours: number | null, hasTime: boolean): string {
  if (hours === null) return '—';
  if (!hasTime || hours >= 48) return `${(hours / 24).toFixed(1).replace(/\.0$/, '')} дн.`;
  return `${hours.toFixed(1).replace(/\.0$/, '')} ч`;
}

/** Минимум дневных значений для Sharpe/Sortino */
const MIN_RATIO_DAYS = 20;
const ratio = (v: number | null): string => (v === null ? '—' : v.toFixed(2));
const pct = (v: number | null, digits = 0): string => (v === null ? '—' : `${v.toFixed(digits)}%`);
const rub = (v: string): string => formatMoney(v, 'RUB');
const toneOfStr = (v: string): KpiTone => toneOf(Number(v));

interface Kpi {
  label: string;
  value: string;
  tone?: KpiTone;
  hint?: string;
  sub?: string;
}

interface KpiGroup {
  title: string;
  /** по какой величине посчитаны метрики группы (базис из DTO) */
  basis?: string;
  items: Kpi[];
}

/**
 * Плашки статистики системы. Только форматирует готовые числа DTO — ни одной формулы
 * (математика в @core/performance.ts). Сгруппированы по смыслу, как в отчётах
 * трейдинговых платформ: итог → сделки → качество → риск → время.
 */
@Component({
  selector: 'app-system-kpis',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [KpiCard],
  template: `
    @for (group of groups(); track group.title) {
      <h2 class="group-title">{{ group.title }}</h2>
      @if (group.basis) {
        <p class="group-basis">{{ group.basis }}</p>
      }
      <div class="kpi-grid">
        @for (kpi of group.items; track kpi.label) {
          <app-kpi-card
            [label]="kpi.label"
            [value]="kpi.value"
            [tone]="kpi.tone ?? 'neutral'"
            [hint]="kpi.hint ?? ''"
            [sub]="kpi.sub ?? ''"
          />
        }
      </div>
    }
  `,
  styles: [
    `
      .group-basis {
        margin: -4px 0 8px;
        font-size: 12px;
        color: var(--app-text-muted);
      }
      .group-title {
        margin: 8px 0;
        font-size: 14px;
        font-weight: 500;
        color: var(--app-text-muted);
      }
    `,
  ],
})
export class SystemKpis {
  readonly performance = input.required<SystemPerformance>();

  protected readonly groups = computed<KpiGroup[]>(() => {
    const p = this.performance();
    const s = p.summary;
    const tm = p.tradeMetrics;
    const t = tm.trades;
    const q = tm.quality;
    const h = tm.holding;
    const r = p.equityMetrics;
    // на нескольких днях отношение среднего к σ — шум: не показываем
    const enough = r.days >= MIN_RATIO_DAYS;
    const sparse = enough ? undefined : `мало данных: ${r.days} дн. из ${MIN_RATIO_DAYS}`;
    return [
      {
        title: 'Итог',
        items: [
          {
            label: 'Результат (закрытые)',
            value: rub(s.closedResultRub),
            tone: toneOfStr(s.closedResultRub),
            sub: `сделки ${rub(s.netPnlRub)} · выплаты ${rub(s.closedIncomeRub)}`,
            hint: 'Результат закрытых сделок после комиссий плюс дивиденды и купоны, полученные по ним.',
          },
          {
            label: 'Открытые позиции',
            value: rub(s.openResultRub),
            tone: toneOfStr(s.openResultRub),
            sub:
              s.openCount > 0
                ? `цена ${rub(s.unrealizedRub)} · продано ${rub(s.openRealizedRub)} · выплаты ${rub(s.openIncomeRub)}`
                : 'открытых нет',
            hint: 'Изменение цены остатка плюс уже зафиксированное по этим сделкам (частично проданное, комиссии входа) плюс дивиденды и купоны. «Результат (закрытые)» + «Открытые позиции» = «Всего».',
          },
          {
            label: 'Дивиденды и купоны',
            value: rub(s.incomeRub),
            tone: toneOfStr(s.incomeRub),
            hint: 'Выплаты по всем сделкам системы, включая закрытые. Часть по открытым уже входит в «Открытые позиции».',
          },
          {
            label: 'Всего',
            value: rub(s.totalRub),
            tone: toneOfStr(s.totalRub),
            hint: 'Сумма карточек «Результат (закрытые)» и «Открытые позиции».',
          },
          {
            label: 'Комиссии',
            value: rub(s.feesTotalRub),
            sub:
              s.feeSharePct === null
                ? 'доля от gross не определена'
                : `закрытые: ${rub(s.feesRub)} — ${s.feeSharePct.toFixed(1)}% от gross`,
            hint: 'Фактические комиссии из отчёта брокера (брокер + биржа). Уже вычтены из результата.',
          },
        ],
      },
      {
        title: 'Сделки',
        basis: tm.basis,
        items: [
          { label: 'Закрытых сделок', value: String(t.closed), sub: `прибыльных ${t.wins} · убыточных ${t.losses}` },
          { label: 'Win rate', value: pct(t.winRatePct) },
          {
            label: 'Лонг',
            value: rub(t.long.netPnlRub),
            tone: toneOfStr(t.long.netPnlRub),
            sub: `${t.long.count} сд. · win ${pct(t.long.winRatePct)}`,
          },
          {
            label: 'Шорт',
            value: rub(t.short.netPnlRub),
            tone: toneOfStr(t.short.netPnlRub),
            sub: `${t.short.count} сд. · win ${pct(t.short.winRatePct)}`,
          },
        ],
      },
      {
        title: 'Качество',
        basis: tm.basis,
        items: [
          { label: 'Profit factor', value: ratio(q.profitFactor), hint: 'Сумма прибылей / сумма убытков. «—» — убытков не было.' },
          { label: 'Payoff ratio', value: ratio(q.payoffRatio), hint: 'Средний выигрыш / |средний убыток|.' },
          { label: 'Матожидание', value: rub(q.expectancyRub), tone: toneOfStr(q.expectancyRub), hint: 'Средний результат на закрытую сделку.' },
          { label: 'Ср. выигрыш', value: rub(q.avgWinRub), tone: 'positive' },
          { label: 'Ср. убыток', value: rub(q.avgLossRub), tone: 'negative' },
          { label: 'Лучшая сделка', value: rub(q.largestWinRub), tone: toneOfStr(q.largestWinRub) },
          { label: 'Худшая сделка', value: rub(q.largestLossRub), tone: toneOfStr(q.largestLossRub) },
          {
            label: 'Серии',
            value: `${tm.streaks.maxWins} / ${tm.streaks.maxLosses}`,
            sub: tm.streaks.current.kind
              ? `сейчас: ${tm.streaks.current.length} ${tm.streaks.current.kind === 'win' ? 'прибыльн.' : 'убыточн.'}`
              : 'сейчас: —',
            hint: 'Максимум подряд прибыльных / убыточных сделок.',
          },
        ],
      },
      {
        title: 'Риск',
        basis: r.basis,
        items: [
          {
            label: 'Макс. просадка',
            value: rub(r.maxDrawdownRub),
            tone: Number(r.maxDrawdownRub) > 0 ? 'negative' : 'neutral',
            sub: r.peakDate ? `${r.peakDate} → ${r.recoveryDate ?? 'не восстановлена'}` : undefined,
            hint: 'Наибольшее падение дневного результата системы (с переоценкой открытых позиций) от пика до дна, в ₽.',
          },
          { label: 'Длительность просадки', value: `${r.drawdownDays} дн.`, hint: 'От пика до восстановления (или до последней точки, если не восстановилась).' },
          { label: 'Recovery factor', value: ratio(r.recoveryFactor), hint: 'Результат за период кривой / макс. просадка.' },
          { label: 'Sharpe', value: enough ? ratio(r.sharpe) : '—', sub: sparse, hint: r.assumptions },
          { label: 'Sortino', value: enough ? ratio(r.sortino) : '—', sub: sparse, hint: r.assumptions },
        ],
      },
      {
        title: 'Время',
        basis: tm.basis,
        items: [
          { label: 'Ср. срок', value: formatHolding(h.avgHours, h.hasTime) },
          { label: 'Ср. срок прибыльных', value: formatHolding(h.avgWinHours, h.hasTime) },
          { label: 'Ср. срок убыточных', value: formatHolding(h.avgLossHours, h.hasTime) },
        ],
      },
    ];
  });
}
