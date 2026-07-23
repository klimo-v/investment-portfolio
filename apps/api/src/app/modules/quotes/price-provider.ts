/**
 * Абстракция источника цен (CLAUDE.md §7: ISP/DIP).
 * Каждый рынок (MOEX, крипта) реализует этот узкий интерфейс, сервис зависит
 * от абстракции, а не от конкретного провайдера.
 */
export interface Quote {
  ticker: string;
  price: string; // десятичная строка (точность — decimal.js)
  currency: string;
  source: 'moex' | 'cbr' | 'binance' | 'manual';
  asOf: string; // ISO-время получения
}

export interface PriceProvider {
  /** Поддерживает ли провайдер данный тикер/тип инструмента */
  supports(marketSource: string): boolean;
  /** Получить цену по тикеру; null если не найдено */
  getQuote(ticker: string): Promise<Quote | null>;
}

/** Токен для DI-провайдеров цен */
export const PRICE_PROVIDERS = Symbol('PRICE_PROVIDERS');
