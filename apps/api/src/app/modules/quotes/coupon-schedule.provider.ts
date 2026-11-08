import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { fetchWithTimeout } from './http';

/**
 * График купонов облигации с MOEX ISS (statistics/engines/stock/markets/bonds/bondization/{SECID}).
 * Нужен только проверке полноты журнала: бумага удерживалась на дату фиксации, а купона нет.
 * Узкий интерфейс (ISP) — сеть можно подменить в тестах, разбор ответа — чистая функция под
 * тестами на зафиксированном ответе биржи.
 */

export interface IssCouponsResponse {
  coupons?: { columns: string[]; data: (string | number | null)[][] };
}

export interface ParsedCoupon {
  couponDate: string;
  recordDate: string | null;
  /** купон на одну бумагу, ₽; null — биржа не отдала рублёвую сумму (валютная облигация) */
  amountRub: string | null;
}

export function parseBondizationCoupons(json: IssCouponsResponse): ParsedCoupon[] {
  const section = json.coupons;
  if (!section) return [];
  const col = (name: string) => section.columns.indexOf(name);
  const iDate = col('coupondate');
  const iRecord = col('recorddate');
  const iRub = col('value_rub');
  if (iDate < 0) return [];
  const out: ParsedCoupon[] = [];
  for (const row of section.data) {
    const date = row[iDate];
    if (typeof date !== 'string') continue;
    const record = iRecord >= 0 ? row[iRecord] : null;
    const rub = iRub >= 0 ? row[iRub] : null;
    out.push({
      couponDate: date,
      recordDate: typeof record === 'string' ? record : null,
      amountRub: rub === null || rub === undefined || rub === '' ? null : new Decimal(rub).toString(),
    });
  }
  return out.sort((a, b) => a.couponDate.localeCompare(b.couponDate));
}

export interface CouponScheduleProvider {
  /** Купоны с датой выплаты в [from, till] включительно; сбой источника — исключение */
  getCoupons(secid: string, from: string, till: string): Promise<ParsedCoupon[]>;
}

/** Токен для DI провайдера графика купонов */
export const COUPON_SCHEDULE_PROVIDER = Symbol('COUPON_SCHEDULE_PROVIDER');

/**
 * Запрос окнами по 3 года: ISS отдаёт блок купонов порциями (на длинном окне приходит только
 * начало списка), а по ограниченному окну — все выплаты окна.
 */
const WINDOW_YEARS = 3;
/** Предохранитель от бесконечного цикла при кривых датах: 10 окон по 3 года = 30 лет истории */
const MAX_WINDOWS = 10;

function addYears(iso: string, years: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class MoexCouponProvider implements CouponScheduleProvider {
  async getCoupons(secid: string, from: string, till: string): Promise<ParsedCoupon[]> {
    const all = new Map<string, ParsedCoupon>();
    for (let start = from, n = 0; start <= till && n < MAX_WINDOWS; n++) {
      const next = addYears(start, WINDOW_YEARS);
      const end = next > till ? till : new Date(Date.parse(next) - 86_400_000).toISOString().slice(0, 10);
      const url =
        `https://iss.moex.com/iss/statistics/engines/stock/markets/bonds/bondization/${encodeURIComponent(secid)}.json` +
        `?iss.meta=off&iss.only=coupons&coupons.columns=coupondate,recorddate,value_rub&from=${encodeURIComponent(start)}&till=${encodeURIComponent(end)}`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`MOEX ISS bondization ${secid}: HTTP ${res.status}`);
      const json = (await res.json()) as IssCouponsResponse;
      // HTTP 200 без блока купонов — неожиданный формат (переименование колонок, заглушка биржи), а не
      // «купонов нет» (у бумаги без купонов блок приходит пустым): пустой график стёр бы кэш и скрыл проверку
      if (!json.coupons) throw new Error(`MOEX ISS bondization ${secid}: в ответе нет блока coupons`);
      for (const c of parseBondizationCoupons(json)) all.set(c.couponDate, c);
      start = next;
    }
    return [...all.values()].sort((a, b) => a.couponDate.localeCompare(b.couponDate));
  }
}
