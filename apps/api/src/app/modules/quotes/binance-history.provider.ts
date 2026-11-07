import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { HistoryPoint, HistoryTarget, PriceHistoryProvider } from './price-history.provider';

/**
 * Дневные свечи Binance (klines) для крипты. Как и текущая цена (binance.provider.ts):
 * пара к USDT, цена в USD (USDT ≈ 1 USD), пересчёт в рубли — по курсу доллара ЦБ.
 * Берём цену закрытия дня. USDT — расчётный актив, пары USDTUSDT нет: цена 1 на каждый день.
 */
const DAY_MS = 86_400_000;
const LIMIT = 1000;

type Kline = [number, string, string, string, string, ...unknown[]];

/** Свечи → точки: дата открытия свечи (UTC), цена закрытия */
export function parseKlines(klines: readonly Kline[]): HistoryPoint[] {
  return klines.map((k) => ({
    date: new Date(k[0]).toISOString().slice(0, 10),
    price: new Decimal(k[4]).toString(),
    currency: 'USD',
    accruedInterest: null,
    accruedCurrency: null,
    source: 'binance' as const,
  }));
}

function eachDay(from: string, till: string): string[] {
  const days: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(till); t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

@Injectable()
export class BinanceHistoryProvider implements PriceHistoryProvider {
  supports(target: HistoryTarget): boolean {
    return target.kind === 'instrument' && target.marketSource === 'binance';
  }

  async getHistory(target: HistoryTarget, from: string, till: string): Promise<HistoryPoint[]> {
    const base = target.ticker.toUpperCase();
    if (base === 'USDT') {
      return eachDay(from, till).map((date) => ({
        date,
        price: '1',
        currency: 'USD',
        accruedInterest: null,
        accruedCurrency: null,
        source: 'binance' as const,
      }));
    }
    const points: HistoryPoint[] = [];
    let start = Date.parse(from);
    const end = Date.parse(till) + DAY_MS - 1;
    while (start <= end) {
      const url =
        `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(base + 'USDT')}` +
        `&interval=1d&startTime=${start}&endTime=${end}&limit=${LIMIT}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Binance ${base}: HTTP ${res.status}`);
      const klines = (await res.json()) as Kline[];
      if (klines.length === 0) break;
      points.push(...parseKlines(klines));
      if (klines.length < LIMIT) break;
      start = klines[klines.length - 1][0] + DAY_MS;
    }
    return points;
  }
}
