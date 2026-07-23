import { Injectable } from '@nestjs/common';
import type { PriceProvider, Quote } from './price-provider';

/**
 * Провайдер цен MOEX ISS (Adapter к единому PriceProvider, CLAUDE.md §7).
 * Бесплатный официальный API Московской биржи.
 *
 * Формат ответа ISS: секции вида { columns: [...], data: [[...]] }.
 * Цену берём из секции marketdata (LAST по основному режиму торгов).
 */

interface IssSection {
  columns: string[];
  data: (string | number | null)[][];
}
interface IssResponse {
  marketdata?: IssSection;
}

// движки/рынки MOEX, где ищем инструмент по типам из справочника
const MARKETS = [
  'engines/stock/markets/shares', // акции, ETF
  'engines/stock/markets/bonds', // облигации
  'engines/currency/markets/selt', // валюта (GLDRUB_TOM и т.п.)
];

@Injectable()
export class MoexProvider implements PriceProvider {
  supports(marketSource: string): boolean {
    return marketSource === 'moex';
  }

  async getQuote(ticker: string): Promise<Quote | null> {
    for (const market of MARKETS) {
      const price = await this.fetchLast(market, ticker);
      if (price !== null) {
        return {
          ticker,
          price,
          currency: 'RUB',
          source: 'moex',
          asOf: new Date().toISOString(),
        };
      }
    }
    return null;
  }

  private async fetchLast(market: string, ticker: string): Promise<string | null> {
    const url =
      `https://iss.moex.com/iss/${market}/securities/${encodeURIComponent(ticker)}.json` +
      `?iss.meta=off&iss.only=marketdata&marketdata.columns=SECID,LAST`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const json = (await res.json()) as IssResponse;
      const md = json.marketdata;
      if (!md) return null;
      const secidIdx = md.columns.indexOf('SECID');
      const lastIdx = md.columns.indexOf('LAST');
      if (secidIdx < 0 || lastIdx < 0) return null;
      // выбираем первую строку с ненулевым LAST
      for (const row of md.data) {
        const last = row[lastIdx];
        if (last !== null && last !== undefined && last !== '') {
          return String(last);
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}
