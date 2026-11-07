/**
 * Идентичность инструментов при импорте: нормализация кодов и резолв «строка отчёта →
 * инструмент справочника». Всё здесь — чистые функции без БД, чтобы правила
 * тестировались сами по себе, а ImportService только применял готовый план.
 *
 * Два разных механизма (docs/02-data-model.md, «Идентичность инструментов»):
 *  1. Нормализация кода — детерминированное правило (`TMON@` → `TMON`). Применяется
 *     ко всем строкам ВСЕХ источников одним общим шагом (`normalizeRawRows`),
 *     а не внутри отдельного парсера.
 *  2. Сопоставление идентичностей — данные: решение человека или сильный
 *     идентификатор (figi, uid, ISIN). Хранится в БД (`instrument_identifiers`),
 *     сюда попадает индексом (`InstrumentIdentityIndex`).
 */
import type { RawRow } from './import';
import { isValidIsin } from './isin';

// ───────────────────────── типы ─────────────────────────

/** Схема идентификатора; порядок в `SCHEME_PRIORITY` — по убыванию силы */
export type IdentifierScheme = 'ticker' | 'isin' | 'figi' | 'tbank_uid' | 'broker_code' | 'name';
export type IdentifierOrigin = 'import' | 'merge' | 'manual';

/** Сильные идентификаторы, которые реально знает парсер (кроме тикера и названия) */
export interface InstrumentIdentifiers {
  /** Только ВАЛИДНЫЙ ISIN (isValidIsin); невалидный код — это brokerCode */
  isin?: string;
  figi?: string;
  tbankUid?: string;
  /** Внутренний код брокера, не являющийся ISIN (напр. TCS00A10B4K3 у Т-Банка) */
  brokerCode?: string;
}

/** От сильных к слабым: этот порядок определяет, кто «главнее» при резолве */
export const SCHEME_PRIORITY: readonly IdentifierScheme[] = [
  'tbank_uid',
  'figi',
  'isin',
  'broker_code',
  'ticker',
  'name',
];

export interface IdentityEntry {
  scheme: IdentifierScheme;
  /** нормализованное значение (код — normalizeCode, название — normalizeName) */
  value: string;
  instrumentId: string;
  origin: IdentifierOrigin;
}

/** Минимум полей инструмента, нужный резолву и эвристикам подсказок */
export interface IdentityInstrument {
  id: string;
  ticker: string;
  type: string;
  currency: string;
  name?: string | null;
  isin?: string | null;
}

// ───────────────────────── нормализация ─────────────────────────

/**
 * Правило нормализации кода. Требования: детерминированное, идемпотентное, не зависит
 * от источника. Специфика конкретного брокера (TCS00… ≠ ISIN) — не нормализация,
 * это решают идентификаторы.
 */
export type CodeRule = (code: string) => string;

const trimCode: CodeRule = (c) => c.trim();
/** Маркер денежных фондов у Т-Банка: «TMON@» — тот же актив, что и «TMON» */
const stripTrailingAt: CodeRule = (c) => c.replace(/@+$/, '');
const upperCode: CodeRule = (c) => c.toUpperCase();

/** Chain: правила применяются по порядку; новое правило — новая функция в списке */
export const CODE_RULES: readonly CodeRule[] = [trimCode, stripTrailingAt, upperCode, trimCode];

/** Нормализованный код; пустое значение → undefined */
export function normalizeCode(code: string | null | undefined): string | undefined {
  if (code === null || code === undefined) return undefined;
  const out = CODE_RULES.reduce((acc, rule) => rule(acc), code);
  return out || undefined;
}

/** Название для сравнения: регистр и повторные пробелы не важны */
export function normalizeName(name: string | null | undefined): string | undefined {
  const n = (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return n || undefined;
}

/**
 * Одна строка: нормализованный тикер и идентификаторы. Если «тикер» на деле валидный
 * ISIN (так отчёты репортят внебиржевые сделки и выплаты), он переезжает в
 * `identifiers.isin`; невалидный ISIN становится `brokerCode`. Идемпотентно.
 */
export function normalizeRawRow(row: RawRow): RawRow {
  const ids = row.identifiers ?? {};
  let ticker = normalizeCode(row.ticker);
  let isin = normalizeCode(ids.isin);
  let brokerCode = normalizeCode(ids.brokerCode);
  const figi = normalizeCode(ids.figi);
  const tbankUid = ids.tbankUid?.trim().toLowerCase() || undefined;

  if (ticker && isValidIsin(ticker)) {
    isin = isin ?? ticker;
    ticker = undefined;
  }
  if (isin && !isValidIsin(isin)) {
    brokerCode = brokerCode ?? isin;
    isin = undefined;
  }

  const identifiers: InstrumentIdentifiers = {};
  if (isin) identifiers.isin = isin;
  if (figi) identifiers.figi = figi;
  if (tbankUid) identifiers.tbankUid = tbankUid;
  if (brokerCode) identifiers.brokerCode = brokerCode;

  const { identifiers: _old, ticker: _oldTicker, ...rest } = row;
  void _old;
  void _oldTicker;
  return {
    ...rest,
    ...(ticker ? { ticker } : {}),
    ...(Object.keys(identifiers).length > 0 ? { identifiers } : {}),
  };
}

/** Общий шаг конвейера импорта между парсером и резолвом (для любого источника) */
export function normalizeRawRows(rows: RawRow[]): RawRow[] {
  return rows.map(normalizeRawRow);
}

/**
 * Код, под которым строка показывается пользователю и по которому он принимает
 * решения (выбор «новый / существующий», система по тикеру), а также id нового
 * инструмента. Ожидает нормализованную строку.
 */
export function identityKey(row: RawRow): string | undefined {
  const ids = row.identifiers;
  return row.ticker ?? ids?.isin ?? ids?.brokerCode ?? ids?.figi ?? ids?.tbankUid;
}

/** Коды строки в порядке силы схем (название — последним, как слабый ключ) */
export function rowCodes(row: RawRow): Array<{ scheme: IdentifierScheme; value: string }> {
  const ids = row.identifiers ?? {};
  const out: Array<{ scheme: IdentifierScheme; value: string }> = [];
  if (ids.tbankUid) out.push({ scheme: 'tbank_uid', value: ids.tbankUid });
  if (ids.figi) out.push({ scheme: 'figi', value: ids.figi });
  if (ids.isin) out.push({ scheme: 'isin', value: ids.isin });
  if (ids.brokerCode) out.push({ scheme: 'broker_code', value: ids.brokerCode });
  if (row.ticker) out.push({ scheme: 'ticker', value: row.ticker });
  const name = normalizeName(row.name);
  if (name) out.push({ scheme: 'name', value: name });
  return out;
}

// ───────────────────────── индекс ─────────────────────────

/** Что известно справочнику: инструменты и их идентификаторы (scheme+value уникальны) */
export class InstrumentIdentityIndex {
  private readonly byKey = new Map<string, string>();
  private readonly meta = new Map<string, IdentityInstrument>();

  static from(instruments: IdentityInstrument[], entries: IdentityEntry[]): InstrumentIdentityIndex {
    const index = new InstrumentIdentityIndex();
    for (const i of instruments) index.meta.set(i.id, i);
    for (const e of entries) index.add(e);
    return index;
  }

  private static key(scheme: IdentifierScheme, value: string): string {
    return `${scheme}\u0000${value}`;
  }

  find(scheme: IdentifierScheme, value: string): string | undefined {
    return this.byKey.get(InstrumentIdentityIndex.key(scheme, value));
  }

  instrument(id: string): IdentityInstrument | undefined {
    return this.meta.get(id);
  }

  instruments(): IdentityInstrument[] {
    return [...this.meta.values()];
  }

  addInstrument(i: IdentityInstrument): void {
    this.meta.set(i.id, i);
  }

  /** false — пара (схема, значение) уже принадлежит инструменту: чужой не перезаписываем */
  add(entry: IdentityEntry): boolean {
    const k = InstrumentIdentityIndex.key(entry.scheme, entry.value);
    if (this.byKey.has(k)) return false;
    this.byKey.set(k, entry.instrumentId);
    return true;
  }

  clone(): InstrumentIdentityIndex {
    const c = new InstrumentIdentityIndex();
    for (const [k, v] of this.byKey) c.byKey.set(k, v);
    for (const [k, v] of this.meta) c.meta.set(k, v);
    return c;
  }
}

// ───────────────────────── подсказки (эвристики) ─────────────────────────

/** Что сравниваем: коды и название строки отчёта либо уже заведённого инструмента */
export interface SimilarityProbe {
  codes: string[];
  name?: string | null;
  type?: string | null;
}

/** Эвристика возвращает причину («похоже, потому что…») или null. Только подсказка */
export type SimilarityHeuristic = (probe: SimilarityProbe, candidate: IdentityInstrument) => string | null;

export interface InstrumentSuggestion {
  instrumentId: string;
  ticker: string;
  name: string | null;
  reason: string;
}

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Длинные коды с общим окончанием: TCS00A10B4K3 ↔ RU000A10B4K3 (брокерский код того же выпуска) */
export const sharedCodeTail: SimilarityHeuristic = (probe, candidate) => {
  const own = [candidate.ticker, candidate.isin].filter((c): c is string => !!c).map((c) => normalizeCode(c) ?? '');
  for (const code of probe.codes) {
    for (const other of own) {
      if (code === other || code.length < 10 || other.length < 10) continue;
      if (commonSuffixLength(code, other) >= 8) return `окончание кода совпадает с «${other}»`;
    }
  }
  return null;
};

/** Тикеры совпали после нормализации (для уже заведённых дублей вида TMON@ / TMON) */
export const sameNormalizedTicker: SimilarityHeuristic = (probe, candidate) => {
  const own = normalizeCode(candidate.ticker);
  return own && probe.codes.some((c) => c === own) ? `тикер совпадает после нормализации («${own}»)` : null;
};

function nameTokens(name: string | null | undefined): Set<string> {
  const n = normalizeName(name);
  return new Set((n ?? '').split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3));
}

/** Похожее название: пересечение слов ≥ 60% либо одно название целиком входит в другое */
export const similarName: SimilarityHeuristic = (probe, candidate) => {
  const a = nameTokens(probe.name);
  const b = nameTokens(candidate.name);
  if (a.size === 0 || b.size === 0) return null;
  const common = [...a].filter((t) => b.has(t)).length;
  const jaccard = common / (a.size + b.size - common);
  const contained = common === Math.min(a.size, b.size) && common >= 2;
  return jaccard >= 0.6 || contained ? `похожее название «${candidate.name}»` : null;
};

export const DEFAULT_HEURISTICS: readonly SimilarityHeuristic[] = [sameNormalizedTicker, sharedCodeTail, similarName];

/**
 * Кандидаты из справочника, на которых похож зонд. Только подсказки: на резолв они не
 * влияют (OCP — новая эвристика = новая функция в списке). Тип, если известен у обоих,
 * обязан совпасть: разные классы активов не бывают дублями.
 */
export function suggestInstruments(
  probe: SimilarityProbe,
  candidates: IdentityInstrument[],
  heuristics: readonly SimilarityHeuristic[] = DEFAULT_HEURISTICS,
  limit = 5,
): InstrumentSuggestion[] {
  const out: InstrumentSuggestion[] = [];
  for (const c of candidates) {
    if (probe.type && c.type && probe.type !== c.type) continue;
    for (const h of heuristics) {
      const reason = h(probe, c);
      if (reason) {
        out.push({ instrumentId: c.id, ticker: c.ticker, name: c.name ?? null, reason });
        break;
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

export interface PossibleDuplicate {
  a: IdentityInstrument;
  b: IdentityInstrument;
  reason: string;
  /** Детерминированный дубль (тикеры совпали после нормализации) — слияние безопасно автоматом */
  deterministic: boolean;
}

/** Пары уже заведённых инструментов, похожие на дубли (для списка «Возможные дубли») */
export function findPossibleDuplicates(
  instruments: IdentityInstrument[],
  heuristics: readonly SimilarityHeuristic[] = DEFAULT_HEURISTICS,
): PossibleDuplicate[] {
  const out: PossibleDuplicate[] = [];
  for (let i = 0; i < instruments.length; i++) {
    for (let j = i + 1; j < instruments.length; j++) {
      const a = instruments[i];
      const b = instruments[j];
      if (a.type !== b.type) continue;
      const probe: SimilarityProbe = {
        codes: [a.ticker, a.isin].map((c) => normalizeCode(c)).filter((c): c is string => !!c),
        name: a.name,
        type: a.type,
      };
      for (const h of heuristics) {
        const reason = h(probe, b);
        if (reason) {
          out.push({ a, b, reason, deterministic: h === sameNormalizedTicker && a.currency === b.currency });
          break;
        }
      }
    }
  }
  return out;
}

// ───────────────────────── план резолва ─────────────────────────

/** Решение пользователя по неопознанной строке (ключ — `identityKey`) */
export type IdentityChoice = { action: 'new' } | { action: 'existing'; instrumentId: string };

export interface RowIdentity {
  /** `identityKey` строки; null — у строки нет кодов инструмента (ввод/вывод и т. п.) */
  key: string | null;
  instrumentId: string | null;
  /** Как найден: схема идентификатора, выбор пользователя либо создание нового */
  via: IdentifierScheme | 'choice' | 'new' | null;
  isNew: boolean;
  /** Идентификаторы указывают на разные инструменты и т. п. — строка не импортируется */
  conflict?: string;
  /** Похожие существующие инструменты (только для новых): подсказка пользователю */
  suggestions: InstrumentSuggestion[];
}

export interface NewInstrumentPlan {
  id: string;
  ticker: string;
  type: string;
  currency: string;
  isin: string | null;
  name: string | null;
  entries: IdentityEntry[];
}

export interface IdentityPlan {
  /** Результат по каждой строке, в том же порядке, что и входные строки */
  rows: RowIdentity[];
  /** Инструменты, которые надо завести (в порядке появления) */
  created: NewInstrumentPlan[];
  /** Идентификаторы, которые надо дописать существующим инструментам */
  links: IdentityEntry[];
}

const INSTRUMENT_TYPES = new Set(['Stock', 'Bond', 'ETF', 'Currency', 'Crypto', 'Cash', 'Future']);

const NO_CODES: RowIdentity = { key: null, instrumentId: null, via: null, isNew: false, suggestions: [] };

/**
 * План резолва для всех строк источника. Чистая функция: ничего не пишет, поэтому
 * preview() (dry-run) и commit() используют ОДНУ логику — commit лишь применяет
 * `created` и `links`. Принимает нормализованные строки (`normalizeRawRows`).
 *
 * Порядок силы: tbank_uid → figi → isin → broker_code → ticker → name.
 *  - Совпал любой идентификатор → инструмент найден, новые идентификаторы строки
 *    дописываются к нему (origin 'import').
 *  - Идентификаторы указывают на РАЗНЫЕ инструменты → conflict, ничего не склеиваем.
 *  - Совпало только название — и то лишь при совместимых типе и валюте.
 *  - Ничего не нашлось → новый инструмент (id = нормализованный код; занятый id —
 *    conflict, а не молчаливая привязка к чужому инструменту) + подсказки.
 *  - Название, совпавшее по строке из того же файла, где тикер/ISIN уже резолвится,
 *    учится заранее: порядок строк в файле на результат не влияет (случай LKOH).
 */
export function planInstrumentIdentities(
  rows: RawRow[],
  index: InstrumentIdentityIndex,
  choices: Record<string, IdentityChoice> = {},
): IdentityPlan {
  const work = index.clone();
  const links: IdentityEntry[] = [];
  const created: NewInstrumentPlan[] = [];

  const link = (entry: IdentityEntry): void => {
    if (work.add(entry)) links.push(entry);
  };
  const learnAll = (row: RawRow, instrumentId: string, origin: IdentifierOrigin): void => {
    for (const c of rowCodes(row)) link({ scheme: c.scheme, value: c.value, instrumentId, origin });
  };
  /** Попадания по сильным схемам (без названия) */
  const strongHits = (row: RawRow): Array<{ scheme: IdentifierScheme; value: string; id: string }> => {
    const hits: Array<{ scheme: IdentifierScheme; value: string; id: string }> = [];
    for (const c of rowCodes(row)) {
      if (c.scheme === 'name') continue;
      const id = work.find(c.scheme, c.value);
      if (id) hits.push({ ...c, id });
    }
    return hits;
  };
  const skip = (row: RawRow): boolean => !!row.skipReason || rowCodes(row).length === 0;

  // 1) предварительный проход: название строки с опознанным инструментом запоминаем
  for (const row of rows) {
    if (skip(row)) continue;
    const name = normalizeName(row.name);
    const hit = strongHits(row)[0];
    if (hit && name) link({ scheme: 'name', value: name, instrumentId: hit.id, origin: 'import' });
  }

  const compatible = (row: RawRow, instrumentId: string): boolean => {
    const inst = work.instrument(instrumentId);
    if (!inst) return true;
    const typeOk = !row.instrumentType || !inst.type || row.instrumentType === inst.type;
    const ccyOk = !row.currency || !inst.currency || row.currency.toUpperCase() === inst.currency.toUpperCase();
    return typeOk && ccyOk;
  };

  // 2) основной проход
  const results: RowIdentity[] = rows.map((row) => {
    if (skip(row)) return NO_CODES;
    const key = identityKey(row) ?? null;
    const choice = key ? choices[key] : undefined;

    if (choice?.action === 'existing') {
      if (!work.instrument(choice.instrumentId)) {
        return { ...NO_CODES, key, conflict: `Выбранный инструмент не найден: ${choice.instrumentId}` };
      }
      learnAll(row, choice.instrumentId, 'manual');
      return { key, instrumentId: choice.instrumentId, via: 'choice', isNew: false, suggestions: [] };
    }

    const hits = strongHits(row);
    const ids = new Set(hits.map((h) => h.id));
    if (ids.size > 1) {
      const detail = hits.map((h) => `${h.scheme} «${h.value}» → ${h.id}`).join('; ');
      return {
        ...NO_CODES,
        key,
        conflict: `Идентификаторы строки указывают на разные инструменты (${detail}). Объедините инструменты вручную.`,
      };
    }
    if (hits.length > 0) {
      learnAll(row, hits[0].id, 'import');
      return { key, instrumentId: hits[0].id, via: hits[0].scheme, isNew: false, suggestions: [] };
    }

    const name = normalizeName(row.name);
    const nameHit = choice?.action === 'new' || !name ? undefined : work.find('name', name);
    if (nameHit && compatible(row, nameHit)) {
      learnAll(row, nameHit, 'import');
      return { key, instrumentId: nameHit, via: 'name', isNew: false, suggestions: [] };
    }

    // новый инструмент
    const id = key as string;
    const clash = work.instrument(id);
    if (clash) {
      return {
        ...NO_CODES,
        key,
        conflict:
          `Код «${id}» уже занят инструментом «${clash.ticker}», но идентификаторы строки с ним не совпали. ` +
          'Выберите существующий инструмент вручную.',
      };
    }
    const suggestions =
      choice?.action === 'new'
        ? []
        : suggestInstruments(
            { codes: rowCodes(row).filter((c) => c.scheme !== 'name').map((c) => c.value), name: row.name, type: row.instrumentType },
            work.instruments(),
          );
    const type = INSTRUMENT_TYPES.has(row.instrumentType ?? '') ? (row.instrumentType as string) : 'Stock';
    const plan: NewInstrumentPlan = {
      id,
      ticker: id,
      type,
      currency: row.currency?.trim() || 'RUB',
      isin: row.identifiers?.isin ?? null,
      name: row.name?.trim() || null,
      entries: [],
    };
    work.addInstrument({ id, ticker: id, type, currency: plan.currency, name: plan.name, isin: plan.isin });
    for (const c of rowCodes(row)) {
      const entry: IdentityEntry = { scheme: c.scheme, value: c.value, instrumentId: id, origin: 'import' };
      if (work.add(entry)) plan.entries.push(entry);
    }
    created.push(plan);
    return { key, instrumentId: id, via: 'new', isNew: true, suggestions };
  });

  return { rows: results, created, links };
}
