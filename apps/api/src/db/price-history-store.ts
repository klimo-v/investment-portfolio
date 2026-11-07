import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { shouldReplacePrice, type PriceSource } from '@core';
import { priceHistory } from './schema';

/** Цена на дату — формат строки price_history */
export interface PricePoint {
  date: string; // YYYY-MM-DD
  price: string;
  currency: string;
  accruedInterest: string | null;
  accruedCurrency: string | null;
  source: PriceSource;
}

/**
 * Записать цену дня с учётом приоритета источников (PRICE_SOURCE_PRIORITY в @core):
 * более слабый источник не затирает более сильный на ту же дату. Единственная точка
 * записи в price_history — её используют и сервис истории, и импорт отчётов, и перенос
 * снимков, поэтому политика конфликтов не расходится. true — строка записана.
 */
export function recordPrice(db: Pick<BetterSQLite3Database, 'select' | 'insert'>, instrumentId: string, point: PricePoint): boolean {
  const [existing] = db
    .select()
    .from(priceHistory)
    .where(and(eq(priceHistory.instrumentId, instrumentId), eq(priceHistory.date, point.date)))
    .all();
  if (existing && !shouldReplacePrice(existing.source as PriceSource, point.source)) return false;
  const values = {
    price: point.price,
    currency: point.currency,
    accruedInterest: point.accruedInterest,
    accruedCurrency: point.accruedCurrency,
    source: point.source,
  };
  db.insert(priceHistory)
    .values({ instrumentId, date: point.date, ...values })
    .onConflictDoUpdate({ target: [priceHistory.instrumentId, priceHistory.date], set: values })
    .run();
  return true;
}
