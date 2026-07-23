import { Injectable } from '@nestjs/common';

/**
 * Курсы валют ЦБ РФ (cbr-xml-daily.ru — удобная JSON-обёртка над ЦБ).
 * Нужны для пересчёта валютных инструментов (USD-облигации, крипта) в RUB.
 */

interface CbrValute {
  Value: number;
  Nominal: number;
}
interface CbrResponse {
  Valute: Record<string, CbrValute>;
}

@Injectable()
export class CbrProvider {
  private cache: { rates: Record<string, number>; asOf: number } | null = null;
  private readonly TTL_MS = 60 * 60 * 1000; // 1 час

  /** Курс валюты к рублю (например USD → 78.4). RUB → 1. */
  async getRate(currency: string): Promise<number> {
    if (currency === 'RUB') return 1;
    const rates = await this.getRates();
    return rates[currency] ?? 1;
  }

  private async getRates(): Promise<Record<string, number>> {
    if (this.cache && Date.now() - this.cache.asOf < this.TTL_MS) {
      return this.cache.rates;
    }
    try {
      const res = await fetch('https://www.cbr-xml-daily.ru/daily_json.js');
      if (!res.ok) return this.cache?.rates ?? {};
      const json = (await res.json()) as CbrResponse;
      const rates: Record<string, number> = {};
      for (const [code, v] of Object.entries(json.Valute)) {
        rates[code] = v.Value / v.Nominal;
      }
      this.cache = { rates, asOf: Date.now() };
      return rates;
    } catch {
      return this.cache?.rates ?? {};
    }
  }
}
