import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  InstrumentIdentityIndex,
  isValidIsin,
  normalizeCode,
  normalizeName,
  type IdentityEntry,
  type IdentityInstrument,
} from '@core';
import { instrumentIdentifiers, instruments } from './schema';

type Db = Pick<BetterSQLite3Database, 'select' | 'insert'>;

/** Справочник → индекс идентичностей для чистого резолва (core/instrument-identity.ts) */
export function loadIdentityIndex(db: Db): InstrumentIdentityIndex {
  const metas: IdentityInstrument[] = db
    .select()
    .from(instruments)
    .all()
    .map((i) => ({ id: i.id, ticker: i.ticker, type: i.type, currency: i.currency, name: i.name, isin: i.isin }));
  const entries: IdentityEntry[] = db
    .select()
    .from(instrumentIdentifiers)
    .all()
    .map((r) => ({ scheme: r.scheme, value: r.value, instrumentId: r.instrumentId, origin: r.origin }));
  return InstrumentIdentityIndex.from(metas, entries);
}

/** Записать идентификатор; false — пара (схема, значение) уже у какого-то инструмента */
export function insertIdentifier(db: Db, entry: IdentityEntry): boolean {
  const { changes } = db.insert(instrumentIdentifiers).values(entry).onConflictDoNothing().run();
  return changes > 0;
}

/**
 * Заполняет instrument_identifiers из существующих инструментов (тикер, ISIN, название).
 * Идемпотентно (insert or ignore) и вызывается после миграций при каждом запуске:
 * название нормализуется в TS (SQLite не умеет lower() для кириллицы), поэтому это
 * не SQL-миграция. Код вида «TMON@» нормализуется в «TMON»: при конфликте двух
 * инструментов код достаётся тому, чей тикер уже совпадает с нормализованным, —
 * второй остаётся без этого кода и ждёт слияния (docs/02-data-model.md).
 * Невалидный ISIN в поле isin записывается как код брокера. Возвращает число записей.
 */
export function backfillInstrumentIdentifiers(db: Db): number {
  const rows = db.select().from(instruments).all();
  const exactFirst = [...rows].sort(
    (a, b) => Number(a.ticker !== normalizeCode(a.ticker)) - Number(b.ticker !== normalizeCode(b.ticker)),
  );
  let added = 0;
  const put = (scheme: IdentityEntry['scheme'], value: string | undefined, instrumentId: string): void => {
    if (value && insertIdentifier(db, { scheme, value, instrumentId, origin: 'import' })) added++;
  };
  for (const i of exactFirst) {
    put('ticker', normalizeCode(i.ticker), i.id);
    const isin = normalizeCode(i.isin);
    if (isin) put(isValidIsin(isin) ? 'isin' : 'broker_code', isin, i.id);
    put('name', normalizeName(i.name), i.id);
  }
  return added;
}
