import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { PriceProvider, Quote } from './price-provider';
import { fetchWithTimeout } from './http';

/**
 * Провайдер цен MOEX ISS (Adapter к единому PriceProvider, CLAUDE.md §7).
 * Бесплатный официальный API Московской биржи.
 *
 * Формат ответа ISS: секции вида { columns: [...], data: [[...]] }.
 * Цену берём из секции marketdata (см. PRICE_COLUMNS — LAST и запасные варианты).
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

/**
 * Источники цены в порядке предпочтения.
 *
 * LAST — цена последней сделки, самое честное «сколько дают прямо сейчас», но её
 * НЕТ, пока в сессии не было ни одной сделки: у неликвидных выпусков (ОФЗ-ИН,
 * короткие корпоративные) это обычное состояние, и раньше такая бумага молча
 * оставалась с ценой прошлого обновления — иногда многодневной давности.
 * LCURRENTPRICE и MARKETPRICE — расчётные цены самой биржи, они есть всегда;
 * именно ими брокеры оценивают портфель, когда сделок не было.
 */
const PRICE_COLUMNS = ['LAST', 'LCURRENTPRICE', 'MARKETPRICE'];

/** Код валюты номинала в ISO-код. MOEX обозначает рубль как SUR. */
function faceUnitToCurrency(faceUnit: unknown): string {
  const code = String(faceUnit ?? '').toUpperCase();
  if (!code) return 'RUB';
  return code === 'SUR' || code === 'RUR' ? 'RUB' : code;
}

@Injectable()
export class MoexProvider implements PriceProvider {
  supports(marketSource: string): boolean {
    return marketSource === 'moex';
  }

  async getQuote(ticker: string): Promise<Quote | null> {
    for (const market of MARKETS) {
      const quote = await this.fetchQuote(market, ticker);
      if (quote) {
        return {
          ticker,
          price: quote.price,
          currency: quote.currency,
          accruedInterest: quote.accruedInterest,
          accruedInterestCurrency: quote.accruedCurrency,
          source: 'moex',
          asOf: new Date().toISOString(),
        };
      }
    }
    return null;
  }

  private async fetchQuote(market: string, ticker: string): Promise<IssQuote | null> {
    const isBonds = market.endsWith('/bonds');
    const priceColumns = ['SECID', 'BOARDID', ...PRICE_COLUMNS].join(',');
    const only = isBonds
      ? 'iss.only=securities,marketdata' +
        '&securities.columns=SECID,BOARDID,FACEVALUE,FACEUNIT,ACCRUEDINT,CURRENCYID' +
        `&marketdata.columns=${priceColumns}`
      : `iss.only=marketdata&marketdata.columns=${priceColumns}`;
    const url = `https://iss.moex.com/iss/${market}/securities/${encodeURIComponent(ticker)}.json?iss.meta=off&${only}`;
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) return null;
      return parseIssQuote((await res.json()) as IssResponse, isBonds);
    } catch {
      return null;
    }
  }
}

/** Цена инструмента, разобранная из ответа ISS */
export interface IssQuote {
  /** «чистая» цена одной бумаги в валюте номинала (для облигаций — уже не проценты) */
  price: string;
  /** валюта цены — FACEUNIT облигации */
  currency: string;
  /** НКД на одну бумагу; null — не облигация */
  accruedInterest: string | null;
  /**
   * Валюта НКД — CURRENCYID режима торгов, и она НЕ обязана совпадать с валютой
   * цены. У замещающей RU000A10B4K3 на TQCB цена в USD (FACEUNIT), а НКД в рублях
   * (CURRENCYID=SUR): 26.97 ₽ против 0.32 $ на долларовом TQOD — одни и те же
   * деньги в разных валютах. null — НКД нет.
   */
  accruedCurrency: string | null;
}

/** Значение ячейки ISS, которое можно считать заполненным */
function cell(section: IssSection | undefined, row: number, column: string): string | number | null {
  const idx = section?.columns.indexOf(column) ?? -1;
  if (idx < 0) return null;
  const value = section?.data[row]?.[idx];
  return value === undefined || value === '' ? null : value;
}

/**
 * Разбор ответа ISS в цену. Чистая функция (SRP): сеть остаётся в провайдере,
 * а вся арифметика процентов номинала, выбора режима торгов и приоритета
 * ценовых колонок покрыта юнит-тестами без похода на биржу.
 */
export function parseIssQuote(json: IssResponse, isBonds: boolean): IssQuote | null {
  const md = json.marketdata;
  if (!md) return null;

  // первая строка, где есть хоть какая-то цена; колонки — в порядке предпочтения
  let price: string | number | null = null;
  let row = -1;
  for (let i = 0; i < md.data.length && price === null; i++) {
    for (const column of PRICE_COLUMNS) {
      const value = cell(md, i, column);
      if (value !== null) {
        price = value;
        row = i;
        break;
      }
    }
  }
  if (price === null) return null;

  if (!isBonds)
    return { price: String(price), currency: 'RUB', accruedInterest: null, accruedCurrency: null };

  /*
   * Одна облигация торгуется в нескольких режимах, и НКД у них выражен в РАЗНЫХ
   * валютах: у RU000A10B4K3 на TQCB (расчёты в рублях) ACCRUEDINT=26.97 ₽, а на
   * TQOD (расчёты в долларах) — 0.32 $. Это одни и те же деньги, поэтому номинал,
   * НКД и его валюту берём из строки того же режима, из которого взяли цену, —
   * иначе к рублёвому НКД применился бы долларовый курс.
   */
  const boardId = cell(md, row, 'BOARDID');
  const sec = json.securities;
  const boardIdx = sec?.columns.indexOf('BOARDID') ?? -1;
  const matched =
    boardIdx >= 0 && boardId !== null
      ? (sec?.data.findIndex((r) => r[boardIdx] === boardId) ?? -1)
      : -1;
  // режим не нашёлся — берём первую строку описания, это лучше отказа от цены
  const secRow = matched >= 0 ? matched : 0;

  // цена облигации — % от номинала, переводим в деньги через FACEVALUE
  const faceValue = cell(sec, secRow, 'FACEVALUE');
  if (faceValue === null) return null;

  const accrued = cell(sec, secRow, 'ACCRUEDINT');
  return {
    price: new Decimal(price).div(100).mul(faceValue).toString(),
    // валюта номинала: у замещающих облигаций цена приходит в долларах
    currency: faceUnitToCurrency(cell(sec, secRow, 'FACEUNIT')),
    accruedInterest: accrued === null ? null : new Decimal(accrued).toString(),
    // а НКД — в валюте РАСЧЁТОВ режима, см. IssQuote.accruedCurrency
    accruedCurrency: accrued === null ? null : faceUnitToCurrency(cell(sec, secRow, 'CURRENCYID')),
  };
}
