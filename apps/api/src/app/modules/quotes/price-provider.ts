/**
 * Абстракция источника цен (CLAUDE.md §7: ISP/DIP).
 * Каждый рынок (MOEX, крипта) реализует этот узкий интерфейс, сервис зависит
 * от абстракции, а не от конкретного провайдера.
 */
export interface Quote {
  ticker: string;
  price: string; // десятичная строка (точность — decimal.js)
  /**
   * Валюта ЦЕНЫ, а не инструмента. У замещающих облигаций цена приходит в валюте
   * номинала (USD), хотя торгуются и учитываются они в рублях, — по этой валюте
   * и берётся курс пересчёта в рубли.
   */
  currency: string;
  /**
   * НКД на одну бумагу в валюте `accruedInterestCurrency`; null — инструмент без
   * накопленного купона (акции, ETF, валюта). Биржа котирует облигации «чисто»,
   * без НКД, а брокер
   * показывает стоимость с ним — отсюда расхождение оценки портфеля.
   */
  accruedInterest?: string | null;
  /**
   * Валюта НКД. Отдельно от `currency`, потому что биржа отдаёт НКД в валюте
   * расчётов режима торгов, а цену — в валюте номинала, и у замещающих облигаций
   * это разные валюты. null — НКД нет.
   */
  accruedInterestCurrency?: string | null;
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
