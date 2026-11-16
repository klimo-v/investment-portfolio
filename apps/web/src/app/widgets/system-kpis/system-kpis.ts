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
    const issues = s.valuationIssues.map(issue => {
      const reason = issue.reason === 'no-price' ? 'нет цены'
        : issue.reason === 'no-fx' ? 'нет курса' : `цена от ${issue.priceDate}`;
      return `${issue.instrumentId} (${issue.date}, ${reason})`;
    });
    const incomplete = s.valuationIssues.some(issue => issue.reason !== 'carried');
    const trade = p.tradeSummary;
    const groups: KpiGroup[] = [
      {
        title: 'Результат за период',
        basis: issues.length ? `${incomplete ? 'Неполная оценка' : 'Использованы ранее известные цены'}. ${issues.join(', ')}.` : undefined,
        items: [
          { label: 'Всего', value: rub(s.totalRub), tone: toneOfStr(s.totalRub),
            sub: incomplete ? 'Неполная оценка' : undefined },
          { label: 'Торговый результат', value: rub(s.tradingRub), tone: toneOfStr(s.tradingRub),
            hint: 'Зафиксированный торговый результат за период с учётом комиссий по сделкам.' },
          { label: 'Дивиденды и купоны', value: rub(s.incomeRub), tone: toneOfStr(s.incomeRub),
            hint: 'Выплаты по датам зачисления в выбранном периоде.' },
          { label: 'Отдельные удержания', value: rub(s.standaloneCostsRub),
            hint: 'Отдельные налоги и комиссии за период. Эта сумма вычтена из итога.' },
          { label: 'Изменение переоценки', value: rub(s.revaluationRub), tone: toneOfStr(s.revaluationRub),
            sub: incomplete ? 'Неполная оценка' : undefined,
            hint: 'Разница между переоценкой на конец и на начало периода.' },
        ],
      },
      {
        title: 'Сделки',
        basis: tm.basis,
        items: [
          { label: 'Открыто на конец периода', value: String(trade.openCount) },
          { label: 'Результат закрытых сделок', value: rub(trade.netPnlRub), tone: toneOfStr(trade.netPnlRub),
            hint: 'Торговый результат за весь срок сделок, закрытых в выбранном периоде.' },
          { label: 'Результат открытых сделок', value: trade.openResultRub === null ? '—' : rub(trade.openResultRub),
            sub: trade.openResultRub === null ? 'Не хватает цены или курса на конец периода' : undefined,
            hint: 'Переоценка остатка, реализованная часть и выплаты за весь срок сделок, открытых на конец периода.' },
          { label: 'Комиссии по закрытым сделкам', value: rub(trade.feesRub),
            sub: trade.feeSharePct === null ? undefined : `${trade.feeSharePct.toFixed(1)}% от результата до комиссий` },
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
    if (!t.closed) return groups.filter(g => g.title === 'Результат за период' || g.title === 'Риск' ||
      (g.title === 'Сделки' && trade.openCount > 0));
    return groups;
  });
}
