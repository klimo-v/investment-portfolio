import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { BenchmarkPoint } from '@core';
import type { PriceProvider, Quote } from './price-provider';

/**
 * Провайдер цен MOEX ISS (Adapter к единому PriceProvider, CLAUDE.md §7).
 * Бесплатный официальный API Московской биржи.
 *
 * Формат ответа ISS: секции вида { columns: [...], data: [[...]] }.
 * Цену берём из секции marketdata (LAST по основному режиму торгов).
 *
 * Облигации MOEX котирует в % от номинала, а не в рублях (напр. LAST=82.80
 * значит 82.80% от номинала, а не 82.80 ₽) — для рынка bonds домножаем на
 * FACEVALUE из секции securities, иначе текущая стоимость/P&L считаются
 * в разы заниженными по сравнению со средней ценой покупки (та уже в рублях,
 * см. apps/api/.../tbank-xlsx-report.ts).
 */

interface IssSection {
  columns: string[];
  data: (string | number | null)[][];
}
interface IssResponse {
  securities?: IssSection;
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

  /**
   * История дневных закрытий индекса MOEX (по умолчанию IMOEX) за период —
   * для линии бенчмарка «Портфель vs рынок» на дашборде (docs/05-review-usability.md
   * §1). ISS отдаёт историю страницами по 100 строк, поэтому листаем через start,
   * пока приходят данные. Возвращаем по возрастанию даты.
   */
  async getIndexHistory(from: string, till: string, secid = 'IMOEX'): Promise<BenchmarkPoint[]> {
    const points: BenchmarkPoint[] = [];
    for (let start = 0; start < 10000; start += 100) {
      const url =
        `https://iss.moex.com/iss/history/engines/stock/markets/index/securities/` +
        `${encodeURIComponent(secid)}.json?iss.meta=off&iss.only=history` +
        `&history.columns=TRADEDATE,CLOSE&from=${from}&till=${till}&start=${start}`;
      let rows: (string | number | null)[][];
      try {
        const res = await fetch(url);
        if (!res.ok) break;
        const json = (await res.json()) as { history?: IssSection };
        const section = json.history;
        if (!section) break;
        const dateIdx = section.columns.indexOf('TRADEDATE');
        const closeIdx = section.columns.indexOf('CLOSE');
        rows = section.data;
        if (rows.length === 0) break;
        for (const row of rows) {
          const date = row[dateIdx];
          const close = row[closeIdx];
          if (typeof date === 'string' && close !== null && close !== undefined && close !== '') {
            points.push({ date, close: Number(close) });
          }
        }
      } catch {
        break;
      }
      if (rows.length < 100) break;
    }
    return points;
  }

  private async fetchLast(market: string, ticker: string): Promise<string | null> {
    const isBonds = market.endsWith('/bonds');
    const only = isBonds
      ? 'iss.only=securities,marketdata&securities.columns=SECID,FACEVALUE&marketdata.columns=SECID,LAST'
      : 'iss.only=marketdata&marketdata.columns=SECID,LAST';
    const url = `https://iss.moex.com/iss/${market}/securities/${encodeURIComponent(ticker)}.json?iss.meta=off&${only}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const json = (await res.json()) as IssResponse;
      const md = json.marketdata;
      if (!md) return null;
      const lastIdx = md.columns.indexOf('LAST');
      if (lastIdx < 0) return null;
      // выбираем первую строку с ненулевым LAST
      let last: string | number | null | undefined;
      for (const row of md.data) {
        if (row[lastIdx] !== null && row[lastIdx] !== undefined && row[lastIdx] !== '') {
          last = row[lastIdx];
          break;
        }
      }
      if (last === undefined || last === null) return null;

      if (!isBonds) return String(last);

      // облигация: LAST — % от номинала, переводим в рубли через FACEVALUE
      const sec = json.securities;
      const faceValueIdx = sec?.columns.indexOf('FACEVALUE') ?? -1;
      const faceValue = faceValueIdx >= 0 ? sec?.data[0]?.[faceValueIdx] : null;
      if (faceValue === null || faceValue === undefined || faceValue === '') return null;

      return new Decimal(last).div(100).mul(faceValue).toString();
    } catch {
      return null;
    }
  }
}
