import { z } from 'zod';
import type { Side } from './qsnap-extract';

/**
 * Общие типы среза «ЮВ1». Деньги/цены/количества — десятичные строки (CLAUDE.md §11).
 */

export type { Side };

/** Множитель контракта CR: 1 контракт = 1000 юаней, цена в рублях за юань */
export const CONTRACT_MULTIPLIER = '1000';

/** Ближайшие квартальные фьючерсы на юань: CRH/CRM/CRU/CRZ + цифра года */
export function isCrContract(secCode: string): boolean {
  return /^CR[HMUZ]\d{1,2}$/.test(secCode);
}

/**
 * Допуски сверки qsnap ↔ журнал автомата. Заданы в коде ДО первого прогона и не
 * подгоняются под данные: цена и количество должны совпасть точно, время — до 2 секунд
 * (автомат пишет секундами, QUIK — миллисекундами), комиссии — до копейки.
 */
export const RECONCILE_TOLERANCE = {
  priceAbs: '0',
  qtyAbs: '0',
  timeSec: 2,
  feeAbs: '0.01',
} as const;

/** Минимум циклов, с которого вообще допустимы вердикты; до этого — «предварительно» */
export const MIN_CYCLES_FOR_VERDICT = 30;

export type DiscrepancyKind =
  | 'only-in-automat'
  | 'mismatch-date'
  | 'mismatch-time'
  | 'mismatch-price'
  | 'mismatch-qty'
  | 'mismatch-side'
  | 'mismatch-fee'
  | 'mismatch-contract'
  | 'snapshot-conflict'
  | 'automat-duplicate'
  | 'side-unknown'
  | 'manual-trade'
  | 'missed-half'
  | 'partial-fill'
  | 'signal-fill-mismatch'
  | 'halt'
  | 'exit-not-1020'
  | 'exit-without-position'
  | 'entry-closes-position'
  | 'fees-incomplete'
  | 'calc-trades-diff'
  | 'incomplete-snapshot'
  | 'unfinished-snapshot'
  | 'coverage-hole'
  | 'position-mismatch'
  | 'money-identity'
  | 'money-ambiguous';

export type Severity = 'info' | 'warn' | 'error';

export interface Discrepancy {
  kind: DiscrepancyKind;
  severity: Severity;
  /** дата, к которой относится расхождение (ISO), если есть */
  date: string | null;
  tradeNum: string | null;
  message: string;
}

export const DiscrepancySchema = z.object({
  kind: z.string(),
  severity: z.enum(['info', 'warn', 'error']),
  date: z.string().nullable(),
  tradeNum: z.string().nullable(),
  message: z.string(),
});
