import Decimal from 'decimal.js';
import type { Operation } from './schemas';
import { incomeAmountRub, type ValuationSeries } from './valuation';

/**
 * Дополнения к дневному ряду оценки для графика «Стоимость инструментов во времени»:
 * кэш на каждый день и события (выплаты, продажи) для маркеров.
 */

Decimal.set({ precision: 40 });

const ZERO = new Decimal(0);

/**
 * Кэш на каждый день ряда: богатство минус стоимость позиций = чистый ввод + итог − рыночная стоимость
 * (то же, что чистый ввод + зафиксированное − вложено). Продажа переливает стоимость из позиции в
 * кэш, выплата добавляет в кэш — поэтому верхушка стека «позиции + деньги» = богатство и не падает.
 *
 * Имеет смысл для контура со своим кэшем (весь журнал или один счёт), не для системы/инструмента.
 * На сегодня совпадает с cashBalanceRub (cash.ts): ту же сумму дают журнал и ряд, если в ряд
 * входят и отдельные налоги/комиссии (valuation.ts). Отрицательный кэш — в журнале не хватает
 * ввода денег (сигнал полноты журнала).
 */
export function cashSeries(series: ValuationSeries): string[] {
  const first = series.groups[0];
  if (!first) return [];
  return first.points.map((_, i) => {
    let result = ZERO;
    let market = ZERO;
    for (const g of series.groups) {
      result = result.plus(g.points[i].totalRub);
      market = market.plus(g.points[i].marketValueRub);
    }
    return new Decimal(series.netContributionsRub[i] ?? 0).plus(result).minus(market).toFixed(2);
  });
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
