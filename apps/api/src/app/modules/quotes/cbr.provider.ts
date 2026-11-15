import { Injectable } from '@nestjs/common';
import { fetchWithTimeout } from './http';

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

export const CBR_RETRY_MS = 30_000;

@Injectable()
export class CbrProvider {
  private cache: { rates: Record<string, number>; asOf: number } | null = null;
  private inFlight: Promise<Record<string, number>> | null = null;
  private retryAfter = 0;
  private readonly TTL_MS = 60 * 60 * 1000; // 1 час

  /** RUB = 1; иностранная валюта — только конечный положительный курс. */
  async getRateOrNull(currency: string): Promise<number | null> {
    if (currency === 'RUB') return 1;
    const rate = (await this.getRates())[currency];
    return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null;
  }

  private async getRates(): Promise<Record<string, number>> {
    if (this.cache && Date.now() - this.cache.asOf < this.TTL_MS) {
      return this.cache.rates;
    }
    if (Date.now() < this.retryAfter) return this.cache?.rates ?? {};
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.loadRates();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async loadRates(): Promise<Record<string, number>> {
    try {
      const res = await fetchWithTimeout('https://www.cbr-xml-daily.ru/daily_json.js');
      if (!res.ok) throw new Error(`ЦБ: HTTP ${res.status}`);
      const json = (await res.json()) as CbrResponse;
      const rates: Record<string, number> = {};
      for (const [code, v] of Object.entries(json.Valute)) {
        if (
          typeof v?.Value !== 'number' ||
          typeof v?.Nominal !== 'number' ||
          !Number.isFinite(v.Value) ||
          !Number.isFinite(v.Nominal) ||
          v.Value <= 0 ||
          v.Nominal <= 0
        )
          continue;
        const rate = v.Value / v.Nominal;
        if (Number.isFinite(rate) && rate > 0) rates[code] = rate;
      }
      if (Object.keys(rates).length === 0) throw new Error('ЦБ не вернул пригодные курсы');
      // Некорректный ответ не должен уничтожать пригодный кешированный курс.
      for (const [code, rate] of Object.entries(this.cache?.rates ?? {})) {
        if (!(code in rates) && Number.isFinite(rate) && rate > 0) rates[code] = rate;
      }
      this.cache = { rates, asOf: Date.now() };
      this.retryAfter = 0;
      return rates;
    } catch {
      this.retryAfter = Date.now() + CBR_RETRY_MS;
      return this.cache?.rates ?? {};
    }
  }
}
