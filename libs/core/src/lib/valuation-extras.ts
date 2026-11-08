import Decimal from 'decimal.js';
import type { Operation } from './schemas';
import { dailyCash, dailyCashAt } from './cash';
import { incomeAmountRub, type ValuationSeries } from './valuation';

/**
 * Дополнения к дневному ряду оценки для графика «Стоимость инструментов во времени»:
 * кэш на каждый день и события (выплаты, продажи) для маркеров.
 */

Decimal.set({ precision: 40 });

const ZERO = new Decimal(0);

/**
 * Кэш на каждый день ряда — из ЖУРНАЛА (dailyCash, cash.ts), а не как «богатство − стоимость»:
 * один расчёт на всё приложение (П4). Фильтры `portfolioId`/`systemId` — те же, с какими
 * построен ряд; фьючерсы — `futureIds`.
 *
 * Инвариант: чистый ввод + итог − стоимость = кэш − продажи без позиции (`orphanSellsRub`):
 * продажа без позиции в сделки не попадает, а деньги двигает. Отрицательный кэш — в журнале
 * не хватает ввода денег (сигнал полноты журнала).
 */
export function cashSeries(
  series: ValuationSeries,
  operations: readonly Operation[],
  scope: { portfolioId?: string; systemId?: string; futureIds?: ReadonlySet<string> } = {},
): string[] {
  const first = series.groups[0];
  if (!first) return [];
  const scoped = operations.filter(
    (o) => (!scope.portfolioId || o.portfolioId === scope.portfolioId) && (!scope.systemId || o.systemId === scope.systemId),
  );
  const daily = dailyCash(scoped, scope.futureIds);
  return first.points.map((p) => dailyCashAt(daily, p.date).cashRub.toFixed(2));
}

export type ValuationEventKind = 'payout' | 'sale';

export interface ValuationEvent {
  date: string;
  kind: ValuationEventKind;
  /** null — выплата без привязки к бумаге */
  instrumentId: string | null;
  /** сумма в рублях: выплата — полученные деньги, продажа — выручка (количество × цена × курс) */
  amountRub: string;
}

export interface ValuationEventsRange {
  /** первый день включительно; не задан — с начала журнала */
  from?: string;
  till: string;
  systemId?: string;
  portfolioId?: string;
  futureIds?: ReadonlySet<string>;
}

/**
 * События для маркеров на оси времени: выплаты (Dividend/Coupon) и продажи бумаг. Несколько
 * операций одного вида по одной бумаге в один день сливаются в одну (сумма). Продажи фьючерсов
 * не показываем — выручки у них нет, результат идёт расчётом.
 */
export function valuationEvents(operations: readonly Operation[], range: ValuationEventsRange): ValuationEvent[] {
  const sums = new Map<string, ValuationEvent & { sum: Decimal }>();
  for (const o of operations) {
    const kind: ValuationEventKind | null =
      o.operationType === 'Dividend' || o.operationType === 'Coupon' ? 'payout' : o.operationType === 'Sell' ? 'sale' : null;
    if (!kind) continue;
    if (o.date > range.till || (range.from && o.date < range.from)) continue;
    if (range.systemId && o.systemId !== range.systemId) continue;
    if (range.portfolioId && o.portfolioId !== range.portfolioId) continue;
    if (kind === 'sale' && (!o.instrumentId || range.futureIds?.has(o.instrumentId))) continue;
    const key = `${o.date}|${kind}|${o.instrumentId ?? ''}`;
    const entry = sums.get(key) ?? { date: o.date, kind, instrumentId: o.instrumentId ?? null, amountRub: '0', sum: ZERO };
    entry.sum = entry.sum.plus(incomeAmountRub(o));
    sums.set(key, entry);
  }
  return [...sums.values()]
    .map(({ sum, ...e }) => ({ ...e, amountRub: sum.toFixed(2) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || (a.instrumentId ?? '').localeCompare(b.instrumentId ?? ''));
}
