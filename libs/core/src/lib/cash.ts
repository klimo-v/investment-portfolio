import { grossTradeAmount } from './trade-amount';
import Decimal from 'decimal.js';
import type { Operation } from './schemas';
import { TradeLedger } from './engine';
import { compareOperations } from './operation-order';

/**
 * Денежный остаток счёта («свободные деньги») — то, что лежит на счёте кэшем после
 * всех движений журнала. В отличие от позиций это ВЕЛИЧИНА НА МОМЕНТ, а не за период:
 * остаток нельзя посчитать «за 1 год», его можно посчитать только «на дату». Поэтому
 * функция принимает всю историю до нужной даты и не знает про `from` (см. вызов в
 * operations.service.ts — там срез уже сделан фильтром `till`).
 *
 * Фьючерсы (`futureIds`): их сделки кэш не двигают, вместо них прибавляется
 * реализованный результат (за вычетом комиссий).
 *
 * Считается на decimal.js — деньги никогда не во float (CLAUDE.md §11).
 */

Decimal.set({ precision: 40 });

/**
 * Направление влияния операции на кэш. Знак — только у суммы операции; комиссия
 * (`fee`) уменьшает остаток ВСЕГДА, каким бы ни был тип.
 *
 * `Transfer` — перевод между портфелями: тип общий для обеих сторон, поэтому знак
 * несут сами данные (исходящий перевод пишется отрицательной суммой, входящий —
 * положительной). При корректно заведённой паре по всему журналу переводы
 * взаимно уничтожаются, а в срезе по одному портфелю — нет, что и требуется.
 */
const CASH_SIGN: Record<Operation['operationType'], number> = {
  Deposit: 1, // завели деньги на счёт
  Withdraw: -1, // вывели со счёта
  Buy: -1, // купили бумагу — деньги ушли
  Sell: 1, // продали — деньги пришли
  Dividend: 1, // выплата пришла деньгами
  Coupon: 1,
  Tax: -1, // удержан налог
  Fee: -1, // отдельная комиссия (не привязанная к сделке)
  Transfer: 1, // знак — в данных, см. выше
};

/**
 * Изменение кэша от одной операции в рублях — ЕДИНСТВЕННОЕ место со знаком операции
 * (П4): cashBalanceRub, dailyCash и cashSeries считаются из него. Фьючерсы кэш сделкой
 * не двигают (деньги — реализованный результат, см. dailyCash), поэтому для них 0.
 */
export function cashDelta(op: Operation, futureIds?: ReadonlySet<string>): Decimal {
  if (futureIds && op.instrumentId && futureIds.has(op.instrumentId)) return new Decimal(0);
  const fxRate = new Decimal(op.fxRate ?? '1');
  const amount = grossTradeAmount(op).mul(fxRate);
  const fee = new Decimal(op.fee ?? '0').mul(fxRate);
  return amount.mul(CASH_SIGN[op.operationType]).minus(fee);
}

/** Кэш на конец дня (нарастающим итогом) и накопленные продажи без позиции */
export interface DailyCashPoint {
  date: string;
  cashRub: Decimal;
  /** продажи без позиции (нетто комиссии) нарастающим итогом: деньги пришли, позиции у них нет */
  orphanSellsRub: Decimal;
}

/**
 * Кэш по дням: по одной точке на каждую дату, в которую что-то двигалось (нарастающий итог),
 * по возрастанию дат. Спот — cashDelta; фьючерс — реализованные события TradeLedger (результат
 * за вычетом комиссий, способ А), тем же проходом, чтобы срез по дате и итог не могли разойтись.
 */
export function dailyCash(operations: readonly Operation[], futureIds?: ReadonlySet<string>): DailyCashPoint[] {
  const flows = new Map<string, { cash: Decimal; orphan: Decimal }>();
  const at = (date: string) => {
    let f = flows.get(date);
    if (!f) flows.set(date, (f = { cash: new Decimal(0), orphan: new Decimal(0) }));
    return f;
  };

  for (const op of operations) at(op.date).cash = at(op.date).cash.plus(cashDelta(op, futureIds));

  const ledger = new TradeLedger({ futureIds }, (trade, event) => {
    if (futureIds?.has(trade.instrumentId)) at(event.date).cash = at(event.date).cash.plus(event.rub);
  });
  for (const op of [...operations].sort(compareOperations)) ledger.apply(op);
  for (const o of ledger.orphanSells) at(o.date).orphan = at(o.date).orphan.plus(o.amountRub);

  let cash = new Decimal(0);
  let orphan = new Decimal(0);
  return [...flows.keys()].sort().map((date) => {
    const f = flows.get(date) as { cash: Decimal; orphan: Decimal };
    cash = cash.plus(f.cash);
    orphan = orphan.plus(f.orphan);
    return { date, cashRub: cash, orphanSellsRub: orphan };
  });
}

/** Точка нарастающего итога на дату (последняя ≤ date); до первой операции — нули */
export function dailyCashAt(daily: readonly DailyCashPoint[], date: string): DailyCashPoint {
  let lo = 0;
  let hi = daily.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (daily[mid].date <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 ? daily[found] : { date, cashRub: new Decimal(0), orphanSellsRub: new Decimal(0) };
}

/**
 * Свободные деньги в рублях по журналу операций.
 *
 * Суммы приводятся к рублям по курсу операции (`fxRate`), как и везде в движке:
 * валютный остаток фиксируется по курсу на дату движения, а не переоценивается по
 * сегодняшнему — то же допущение, что и у `investedRub` в engine.ts.
 *
 * ОТРИЦАТЕЛЬНЫЙ результат — не ошибка расчёта, а сигнал о данных: журнал не
 * содержит части денежных движений (пополнений, переводов между счетами, налогов и
 * комиссий, приходящих отдельными строками) либо позиции набирались с плечом.
 * Прятать такой остаток нельзя — он и есть индикатор неполноты журнала.
 */
export function cashBalanceRub(
  operations: Operation[],
  futureIds?: ReadonlySet<string>,
): Decimal {
  const daily = dailyCash(operations, futureIds);
  return daily.length > 0 ? daily[daily.length - 1].cashRub : new Decimal(0);
}

/** Сумма продаж без позиции по журналу (нетто комиссии, ₽) — то, на что кэш журнала больше кэша ряда */
export function orphanSellsRub(operations: readonly Operation[], futureIds?: ReadonlySet<string>): Decimal {
  const daily = dailyCash(operations, futureIds);
  return daily.length > 0 ? daily[daily.length - 1].orphanSellsRub : new Decimal(0);
}

/** Продажи без позиции (нетто комиссии, ₽) списком — для объяснения причины отрицательного кэша */
export function orphanSellList(
  operations: readonly Operation[],
  futureIds?: ReadonlySet<string>,
): { date: string; instrumentId: string; amountRub: Decimal }[] {
  const ledger = new TradeLedger({ futureIds });
  for (const op of [...operations].sort(compareOperations)) ledger.apply(op);
  return ledger.orphanSells;
}
