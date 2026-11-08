import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { HistoryPoint, HistoryTarget, PriceHistoryProvider } from './price-history.provider';
import { fetchWithTimeout } from './http';

/**
 * История официальных курсов ЦБ РФ (XML_dynamic.asp): один запрос на валюту и период.
 * Курс — ₽ за 1 единицу валюты (Value / Nominal). Код валюты ЦБ (VAL_NM_RQ) задан таблицей:
 * неизвестная валюта не поддерживается — день останется «без курса», а не молча 1.
 */
const CBR_CODES: Readonly<Record<string, string>> = {
  USD: 'R01235',
  EUR: 'R01239',
  CNY: 'R01375',
  GBP: 'R01035',
  JPY: 'R01820',
  HKD: 'R01200',
  KZT: 'R01335',
  TRY: 'R01700',
  CHF: 'R01775',
};

/** dd.mm.yyyy → yyyy-mm-dd */
function isoOf(dmy: string): string {
  const [d, m, y] = dmy.split('.');
  return `${y}-${m}-${d}`;
}

/** yyyy-mm-dd → dd/mm/yyyy (формат запроса ЦБ) */
function cbrDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Разбор XML ответа ЦБ без зависимостей: структура плоская и фиксированная */
export function parseCbrDynamic(xml: string): HistoryPoint[] {
  const points: HistoryPoint[] = [];
  const re = /<Record Date="(\d{2}\.\d{2}\.\d{4})"[^>]*>\s*<Nominal>([^<]+)<\/Nominal>\s*<Value>([^<]+)<\/Value>/g;
  for (const m of xml.matchAll(re)) {
    const nominal = new Decimal(m[2].replace(',', '.'));
    const value = new Decimal(m[3].replace(',', '.'));
    if (nominal.isZero()) continue;
    points.push({
      date: isoOf(m[1]),
      price: value.div(nominal).toString(),
      currency: 'RUB',
      accruedInterest: null,
      accruedCurrency: null,
      source: 'cbr',
    });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

@Injectable()
export class CbrHistoryProvider implements PriceHistoryProvider {
  supports(target: HistoryTarget): boolean {
    return target.kind === 'fx' && target.ticker.toUpperCase() in CBR_CODES;
  }

  async getHistory(target: HistoryTarget, from: string, till: string): Promise<HistoryPoint[]> {
    const code = CBR_CODES[target.ticker.toUpperCase()];
    if (!code) return [];
    const url =
      `https://www.cbr.ru/scripts/XML_dynamic.asp?date_req1=${cbrDate(from)}&date_req2=${cbrDate(till)}&VAL_NM_RQ=${code}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`ЦБ ${target.ticker}: HTTP ${res.status}`);
    // ответ в windows-1251, но числа и даты — ASCII, так что декодирование не критично
    const xml = new TextDecoder('windows-1251').decode(await res.arrayBuffer());
    return parseCbrDynamic(xml);
  }
}
