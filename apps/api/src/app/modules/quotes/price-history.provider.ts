import type { PriceSource } from '@core';

/**
 * Источники ИСТОРИИ цен — отдельный узкий интерфейс (ISP), а не раздувание PriceProvider:
 * текущая котировка и дневной ряд за период — разные задачи с разной пагинацией и
 * разными ограничениями источников.
 */

/** Цена на одну дату, как её отдал источник (формат — как в quotes) */
export interface HistoryPoint {
  date: string; // YYYY-MM-DD
  price: string;
  /** валюта ЦЕНЫ (у замещающих облигаций — валюта номинала, а не рубли) */
  currency: string;
  accruedInterest: string | null;
  /** валюта НКД — своя, не обязана совпадать с валютой цены (см. quotes.accrued_currency) */
  accruedCurrency: string | null;
  source: PriceSource;
}

/**
 * Что именно догружаем: бумага из справочника, курс валюты (`kind: 'fx'`, ticker = код валюты)
 * или ряд ориентира (`kind: 'index'`, ticker = SECID индекса MOEX; id вида `index:MCFTRR`).
 */
export interface HistoryTarget {
  /** id в price_history: instruments.id или «fx:USD» */
  instrumentId: string;
  ticker: string;
  kind: 'instrument' | 'fx' | 'index';
  type: 'Stock' | 'Bond' | 'ETF' | 'Currency' | 'Crypto' | 'Cash' | 'Future' | 'Fx' | 'Index';
  currency: string;
  marketSource: 'moex' | 'cbr' | 'binance' | 'manual';
}

export interface PriceHistoryProvider {
  supports(target: HistoryTarget): boolean;
  /** Дневные цены за [from, till] включительно, по возрастанию даты; пустой массив — нет данных */
  getHistory(target: HistoryTarget, from: string, till: string): Promise<HistoryPoint[]>;
}

/** Токен для DI адаптеров истории цен */
export const PRICE_HISTORY_PROVIDERS = Symbol('PRICE_HISTORY_PROVIDERS');
