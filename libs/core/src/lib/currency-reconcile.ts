import Decimal from 'decimal.js';
import { calculatePositions } from './engine';
import { currencyOfPairTicker } from './foreign-cash';
import type { Operation } from './schemas';

/**
 * Сверка валютных остатков журнала с брокером. Кэш приложения — рублёвый, а валюта на счёте — это
 * ПОЗИЦИЯ валютной пары (CNYRUB_TOM → CNY). Поэтому рублёвая сверка расхождение по валюте не покажет:
 * пропущенный вывод юаня оставляет в журнале «лишний» юань, а кэш по рублям сходится. Эта сверка
 * сравнивает количество валюты в журнале с `money` брокера (GetPositions) и называет валюту.
 */

/** Допустимое расхождение в единицах валюты (копейки/хвосты округления брокера) */
export const CURRENCY_TOLERANCE = new Decimal(1);

export interface CurrencyBalance {
  currency: string;
  /** количество валюты, десятичная строка */
  amount: string;
}

export interface CurrencyMismatch {
  currency: string;
  broker: string;
  journal: string;
  /** журнал − брокер: положительное — в журнале валюты больше, чем у брокера */
  diff: string;
}

/** Количество каждой иностранной валюты в журнале: сумма позиций её валютной пары */
export function journalCurrencyBalances(
  operations: readonly Operation[],
  tickerOf: (instrumentId: string) => string | undefined,
): CurrencyBalance[] {
  const totals = new Map<string, Decimal>();
  for (const p of calculatePositions([...operations])) {
    const currency = currencyOfPairTicker(tickerOf(p.instrumentId) ?? '');
    if (!currency) continue;
    totals.set(currency, (totals.get(currency) ?? new Decimal(0)).plus(p.quantity));
  }
  return [...totals].map(([currency, amount]) => ({ currency, amount: amount.toFixed() }));
}

/** Расхождения журнал ↔ брокер по валютам, где хотя бы одна сторона ненулевая; RUB не сверяется */
export function reconcileCurrencyBalances(
  broker: readonly CurrencyBalance[],
  journal: readonly CurrencyBalance[],
  tolerance: Decimal = CURRENCY_TOLERANCE,
): CurrencyMismatch[] {
  const codes = new Set([...broker, ...journal].map((b) => b.currency.toUpperCase()).filter((c) => c !== 'RUB'));
  const amountOf = (list: readonly CurrencyBalance[], code: string): Decimal =>
    list.filter((b) => b.currency.toUpperCase() === code).reduce((s, b) => s.plus(b.amount), new Decimal(0));
  return [...codes]
    .sort()
    .map((currency) => {
      const b = amountOf(broker, currency);
      const j = amountOf(journal, currency);
      return { currency, broker: b.toFixed(), journal: j.toFixed(), diff: j.minus(b).toFixed() };
    })
    .filter((m) => new Decimal(m.diff).abs().gt(tolerance));
}
