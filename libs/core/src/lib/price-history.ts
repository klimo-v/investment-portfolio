/**
 * История цен — ФАКТЫ, из которых считаются все ряды динамики (valuation.ts).
 * Здесь только то, что должно быть одинаково на бэке и в расчёте: откуда берётся
 * цена и какая из двух цен на одну дату побеждает. Хранение и загрузка — в API.
 */

/**
 * Источник точки истории цен. moex/cbr/binance — официальные данные рынка (дневное
 * закрытие, курс ЦБ на дату); broker-report — расчётная цена фьючерса из отчёта брокера;
 * quote — «текущая котировка» момента нажатия «Обновить цены» (внутридневная LAST/свеча,
 * курс из daily_json): это НЕ официальное закрытие дня, поэтому она слабее рынка и не
 * считается покрытием — официальное значение потом заменит её при догрузке; snapshot —
 * цена, восстановленная из старых снимков портфеля (value/quantity); manual — введена руками.
 */
export type PriceSource =
  | 'moex'
  | 'cbr'
  | 'binance'
  | 'broker-report'
  | 'quote'
  | 'snapshot'
  | 'manual';

/**
 * Приоритет источников при конфликте на одну дату — ЕДИНСТВЕННОЕ место политики:
 * рынок > отчёт брокера > котировка момента > снимок > ручная цена. Рынок — проверяемый факт, отчёт брокера
 * — тоже факт, но по расчётной цене; снимок — это value/quantity, а не цена (округлена
 * до копеек стоимости); ручная цена — оценка пользователя, самая слабая, хотя для
 * инструмента без провайдера она единственная.
 */
export const PRICE_SOURCE_PRIORITY: Readonly<Record<PriceSource, number>> = {
  moex: 5,
  cbr: 5,
  binance: 5,
  'broker-report': 4,
  quote: 3,
  snapshot: 2,
  manual: 1,
};

/** Заменяет ли новая точка уже сохранённую на ту же дату (равный приоритет — свежая побеждает) */
export function shouldReplacePrice(existing: PriceSource, incoming: PriceSource): boolean {
  return PRICE_SOURCE_PRIORITY[incoming] >= PRICE_SOURCE_PRIORITY[existing];
}

/** Источник — рынок (а не снимок/ручной ввод): только он «закрывает» диапазон дат при догрузке */
export function isMarketSource(source: PriceSource): boolean {
  return PRICE_SOURCE_PRIORITY[source] >= PRICE_SOURCE_PRIORITY['broker-report'];
}

/**
 * Идентификатор курса валюты в истории цен. Курсы лежат в той же таблице, что и цены
 * бумаг, под синтетическим id «fx:USD» (цена = ₽ за 1 единицу валюты, валюта цены RUB):
 * один механизм догрузки, хранения и чтения, без отдельной таблицы и без FK на instruments.
 */
export function fxInstrumentId(currency: string): string {
  return `fx:${currency.toUpperCase()}`;
}

export function isFxInstrumentId(id: string): boolean {
  return id.startsWith('fx:');
}
