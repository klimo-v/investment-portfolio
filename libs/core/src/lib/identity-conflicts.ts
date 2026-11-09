/**
 * Пометка «подозрительный набор кодов»: у одного инструмента больше одного биржевого тикера.
 * Слияние, которое объединило два разных тикера (CNYRUB_TOM → GLDRUB_TOM), оставляет в наборе
 * кодов оба — по этому признаку ошибку видно сразу. Чистая функция без БД.
 *
 * Что НЕ участвует в правиле (проверено на реальных данных):
 *  - `figi` и `tbank_uid`: у законного инструмента их может быть несколько (RU000A10B4K3 — два
 *    `tbank_uid`), а у ошибочно слитого своего `figi` может не быть вовсе (GLDRUB_TOM);
 *  - тикеры формы ISIN (RU000A10B4K3, TCS00A10B4K3): у облигаций «тикер» — это код выпуска, и
 *    слияние TCS00…→RU000… законно.
 */

import { normalizeCode } from './instrument-identity';

/** Форма ISIN: 2 буквы + 9 букв/цифр + цифра (контрольную сумму не проверяем — TCS00… её не проходит) */
const ISIN_SHAPE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/** Минимум полей кода, нужный правилу (совместим с IdentityEntry и со строкой БД) */
export interface IdentityConflictEntry {
  scheme: string;
  value: string;
}

export interface IdentityConflict {
  /** true — у инструмента больше одного биржевого тикера */
  conflicting: boolean;
  /** различные биржевые тикеры набора (формы ISIN отброшены) */
  tickers: string[];
}

export function identityConflicts(entries: readonly IdentityConflictEntry[]): IdentityConflict {
  const tickers = [
    ...new Set(
      entries
        .filter((e) => e.scheme === 'ticker')
        .map((e) => normalizeCode(e.value))
        .filter((v): v is string => !!v && !ISIN_SHAPE.test(v)),
    ),
  ].sort();
  return { conflicting: tickers.length > 1, tickers };
}
