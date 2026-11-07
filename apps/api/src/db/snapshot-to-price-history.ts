import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { recordPrice } from './price-history-store';

interface SnapshotPositionRaw {
  date: string;
  instrument_id: string;
  value_rub: string;
  quantity: string;
  type: string | null;
}

/**
 * Одноразовый перенос истории из старых снимков (snapshot_positions) в price_history:
 * цена за штуку = value_rub / quantity, источник 'snapshot', валюта RUB. Для инструментов
 * с ручной ценой это ЕДИНСТВЕННАЯ история — терять нельзя.
 *
 * Читает снимки сырым SQL, а не через схему: таблица снимков удаляется отдельной миграцией,
 * и перенос не должен зависеть от её описания в schema.ts.
 *
 * Пропускаем:
 *  - нулевое количество (не из чего делить);
 *  - фьючерсы: «стоимость» фьючерса в снимке — нереализованный результат, а не цена;
 *  - инструменты, которых уже нет в справочнике.
 * Для облигаций стоимость в снимке уже содержит НКД: цена получается «грязной», а НКД в
 * истории пуст — итоговая стоимость позиции та же. Делим Decimal'ом и округляем до 6 знаков:
 * входное value_rub само округлено до копеек, точнее цену восстановить нельзя.
 * Идемпотентно: повторный запуск ничего не меняет (политика приоритетов в recordPrice).
 */
export function copySnapshotsToPriceHistory(db: BetterSQLite3Database): number {
  const rows = db.all<SnapshotPositionRaw>(sql`
    SELECT sp.date AS date, sp.instrument_id AS instrument_id, sp.value_rub AS value_rub,
           sp.quantity AS quantity, i.type AS type
    FROM snapshot_positions sp
    LEFT JOIN instruments i ON i.id = sp.instrument_id
    ORDER BY sp.date, sp.instrument_id
  `);
  let written = 0;
  for (const r of rows) {
    if (r.type === null || r.type === 'Future') continue;
    const qty = new Decimal(r.quantity);
    if (qty.isZero() || qty.isNegative()) continue;
    const price = new Decimal(r.value_rub).div(qty).toDecimalPlaces(6).toString();
    const ok = recordPrice(db, r.instrument_id, {
      date: r.date,
      price,
      currency: 'RUB',
      accruedInterest: null,
      accruedCurrency: null,
      source: 'snapshot',
    });
    if (ok) written++;
  }
  return written;
}
