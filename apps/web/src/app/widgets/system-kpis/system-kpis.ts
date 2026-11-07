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
    const t = p.trades;
    const q = p.quality;
    const r = p.risk;
    const h = p.holding;
    // на нескольких днях отношение среднего к σ — шум: не показываем
    const enough = p.ratios.days >= MIN_RATIO_DAYS;
    const sparse = enough ? undefined : `мало данных: ${p.ratios.days} дн. из ${MIN_RATIO_DAYS}`;
    return [
      {
        title: 'Итог',
        items: [
          {
            label: 'Результат (закрытые)',
            value: rub(s.netPnlRub),
            tone: toneOfStr(s.netPnlRub),
            hint: 'Реализованный результат закрытых сделок после комиссий.',
          },
          {
            label: 'Открытые позиции',
            value: rub(s.unrealizedRub),
            tone: toneOfStr(s.unrealizedRub),
            sub: s.openCount > 0 ? `открытых сделок: ${s.openCount}` : 'открытых нет',
            hint: 'Нереализованный результат по расчётной цене. В реализованный итог не входит.',
          },
          {
            label: 'Всего',
            value: rub(s.totalRub),
            tone: toneOfStr(s.totalRub),
            hint: 'Закрытые + уже зафиксированное по открытым (комиссии входа) + нереализованный.',
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
            value: `${p.streaks.maxWins} / ${p.streaks.maxLosses}`,
            sub: p.streaks.current.kind
              ? `сейчас: ${p.streaks.current.length} ${p.streaks.current.kind === 'win' ? 'прибыльн.' : 'убыточн.'}`
              : 'сейчас: —',
            hint: 'Максимум подряд прибыльных / убыточных сделок.',
          },
        ],
      },
      {
        title: 'Риск',
        items: [
          {
            label: 'Макс. просадка',
            value: rub(r.maxDrawdownRub),
            tone: Number(r.maxDrawdownRub) > 0 ? 'negative' : 'neutral',
            sub: r.peakDate ? `${r.peakDate} → ${r.recoveryDate ?? 'не восстановлена'}` : undefined,
            hint: 'Наибольшее падение накопленного результата от пика до дна, в ₽. Стартовый ноль считается пиком.',
          },
          { label: 'Длительность просадки', value: `${r.drawdownDays} дн.`, hint: 'От пика до восстановления (или до последней точки, если не восстановилась).' },
          { label: 'Recovery factor', value: ratio(r.recoveryFactor), hint: 'Результат закрытых / макс. просадка.' },
          { label: 'Sharpe', value: enough ? ratio(p.ratios.sharpe) : '—', sub: sparse, hint: p.ratios.assumptions },
          { label: 'Sortino', value: enough ? ratio(p.ratios.sortino) : '—', sub: sparse, hint: p.ratios.assumptions },
        ],
      },
      {
        title: 'Время',
        items: [
          { label: 'Ср. срок', value: formatHolding(h.avgHours, h.hasTime) },
          { label: 'Ср. срок прибыльных', value: formatHolding(h.avgWinHours, h.hasTime) },
          { label: 'Ср. срок убыточных', value: formatHolding(h.avgLossHours, h.hasTime) },
        ],
      },
    ];
  });
}
