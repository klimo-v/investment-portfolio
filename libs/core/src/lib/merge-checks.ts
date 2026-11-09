import Decimal from 'decimal.js';
import { identityConflicts, type IdentityConflictEntry } from './identity-conflicts';
import { normalizeCode } from './instrument-identity';
import { isValidIsin } from './isin';

/**
 * Защита слияния инструментов: чистая проверка «source → target» до записи в БД.
 *  - blockers — слияние запрещено, обойти нельзя;
 *  - warnings — слияние возможно только с явным подтверждением (законные корпоративные
 *    действия тоже дают расхождения: смена тикера, нового ISIN).
 * Разные figi/tbank_uid НЕ проверяются: у законного RU000A10B4K3 два tbank_uid, а у ошибочно
 * слитого GLDRUB_TOM своего figi в справочнике нет вовсе.
 */

/** Валютная пара биржи: база + RUB, режим TOM/TOD */
const CURRENCY_PAIR = /^([A-Z]{3})RUB_(?:TOM|TOD)$/;

/** Допустимый разброс медианы «цена операции источника / цена цели на дату» */
export const PRICE_RATIO_RANGE = { min: 0.5, max: 2 } as const;

export interface MergeCheckInstrument {
  id: string;
  ticker: string;
  isin?: string | null;
  /** коды инструмента (instrument_identifiers) */
  entries: readonly IdentityConflictEntry[];
}

export interface MergeCheckContext {
  /** покупки/продажи источника: цена и валюта операции */
  sourceOps: readonly { date: string; price: string; currency: string }[];
  /** история цен цели (любой порядок) */
  targetPrices: readonly { date: string; price: string; currency: string }[];
}

export type MergeIssueCode = 'currency-pair-mismatch' | 'different-isin' | 'ticker-conflict' | 'price-divergence';

export interface MergeIssue {
  code: MergeIssueCode;
  message: string;
}

export interface MergeChecks {
  blockers: MergeIssue[];
  warnings: MergeIssue[];
}

const baseCurrency = (ticker: string): string | undefined => CURRENCY_PAIR.exec(normalizeCode(ticker) ?? '')?.[1];

const validIsin = (i: MergeCheckInstrument): string | undefined => {
  const candidates = [i.isin, i.ticker].map((c) => normalizeCode(c)).filter((c): c is string => !!c);
  return candidates.find((c) => isValidIsin(c));
};

/** Медиана отношений цен или null, если сопоставимых пар нет */
export function medianPriceRatio(ctx: MergeCheckContext): number | null {
  const prices = [...ctx.targetPrices].sort((a, b) => a.date.localeCompare(b.date));
  const ratios: Decimal[] = [];
  for (const op of ctx.sourceOps) {
    const opPrice = new Decimal(op.price);
    if (!opPrice.gt(0)) continue;
    // последняя цена цели не позже даты операции; операция раньше истории цен цели несопоставима
    // (цена другой эпохи дала бы ложное расхождение у активов с большим дрейфом) — пропускаем
    let ref: (typeof prices)[number] | undefined;
    for (const p of prices) if (p.date <= op.date) ref = p;
    if (!ref || ref.currency !== op.currency) continue; // нет цены на дату или валюты разные — несопоставимо
    const refPrice = new Decimal(ref.price);
    if (!refPrice.gt(0)) continue;
    ratios.push(opPrice.div(refPrice));
  }
  if (ratios.length === 0) return null;
  ratios.sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(ratios.length / 2);
  return (ratios.length % 2 ? ratios[mid] : ratios[mid - 1].plus(ratios[mid]).div(2)).toNumber();
}

export function mergeChecks(source: MergeCheckInstrument, target: MergeCheckInstrument, ctx: MergeCheckContext): MergeChecks {
  const blockers: MergeIssue[] = [];
  const warnings: MergeIssue[] = [];

  const a = baseCurrency(source.ticker);
  const b = baseCurrency(target.ticker);
  if (a && b && a !== b) {
    blockers.push({
      code: 'currency-pair-mismatch',
      message: `${source.ticker} и ${target.ticker} — валютные пары с разной базовой валютой (${a} и ${b}): это разные активы, слияние запрещено.`,
    });
  }

  const isinA = validIsin(source);
  const isinB = validIsin(target);
  if (isinA && isinB && isinA !== isinB) {
    warnings.push({
      code: 'different-isin',
      message: `У инструментов разные ISIN: ${isinA} и ${isinB}. Законно только при корпоративном действии (замена выпуска).`,
    });
  }

  const own = (i: MergeCheckInstrument): IdentityConflictEntry[] => {
    const t = normalizeCode(i.ticker);
    return t ? [{ scheme: 'ticker', value: t }] : [];
  };
  const union = [...source.entries, ...target.entries, ...own(source), ...own(target)];
  const conflict = identityConflicts(union);
  if (conflict.conflicting) {
    warnings.push({
      code: 'ticker-conflict',
      message: `После слияния у инструмента будет несколько биржевых тикеров: ${conflict.tickers.join(', ')}.`,
    });
  }

  const ratio = medianPriceRatio(ctx);
  if (ratio !== null && (ratio < PRICE_RATIO_RANGE.min || ratio > PRICE_RATIO_RANGE.max)) {
    warnings.push({
      code: 'price-divergence',
      message: `Цены сделок источника не сходятся с ценами цели: медиана отношения ${ratio.toPrecision(3)} (ожидается ${PRICE_RATIO_RANGE.min}–${PRICE_RATIO_RANGE.max}).`,
    });
  }

  return { blockers, warnings };
}
