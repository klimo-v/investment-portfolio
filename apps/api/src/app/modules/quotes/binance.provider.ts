import { Injectable } from '@nestjs/common';
import type { PriceProvider, Quote } from './price-provider';

/**
 * Провайдер цен криптовалют Binance (Adapter к единому PriceProvider, CLAUDE.md §7).
 * Публичный бесплатный REST /api/v3/ticker/price. Пары котируются к USDT, который
 * принимаем за доллар: цену возвращаем в USD, а пересчёт в RUB делает дальше
 * QuotesService через CBR (как для валютных облигаций). Сам USDT ≈ 1 USD — пары
 * USDTUSDT на бирже нет, поэтому отдаём цену 1 напрямую.
 */
@Injectable()
export class BinanceProvider implements PriceProvider {
  supports(marketSource: string): boolean {
    return marketSource === 'binance';
  }

  async getQuote(ticker: string): Promise<Quote | null> {
    const asOf = new Date().toISOString();
    const base = ticker.toUpperCase();

    // USDT — сам расчётный актив пар, отдельной пары USDTUSDT нет
    if (base === 'USDT') {
      return { ticker, price: '1', currency: 'USD', source: 'binance', asOf };
    }

    try {
      const res = await fetch(
        `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(base + 'USDT')}`,
      );
      if (!res.ok) return null;
      const json = (await res.json()) as { price?: string };
      if (!json.price) return null;
      return { ticker, price: json.price, currency: 'USD', source: 'binance', asOf };
    } catch {
      return null;
    }
  }
}
