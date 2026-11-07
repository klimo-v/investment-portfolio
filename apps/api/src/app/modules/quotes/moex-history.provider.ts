import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { futuresMultiplier, scaleByPowerOfTen, tickerToExchangeCode } from '@core';
import type { HistoryPoint, HistoryTarget, PriceHistoryProvider } from './price-history.provider';

/**
 * История цен MOEX ISS: акции/ETF, облигации (с НКД на дату), валюта (SELT), фьючерсы.
 * ISS отдаёт историю страницами по 100 строк по всем режимам торгов сразу — листаем
 * через `start` (как getIndexHistory) и на каждую дату берём строку основного режима.
 */

interface IssHistorySection {
  columns: string[];
  data: (string | number | null)[][];
}
export interface IssHistoryResponse {
  history?: IssHistorySection;
}

export type IssHistoryKind = 'shares' | 'bonds' | 'selt' | 'forts';

const PAGE = 100;

/** Основные режимы торгов — тай-брейк, когда колонки оборота (VALUE) в ответе нет */
const MAIN_BOARDS = ['TQBR', 'TQTF', 'TQIF', 'TQCB', 'TQOB', 'CETS', 'FUT'];

function faceUnitToCurrency(code: unknown): string {
  const c = String(code ?? '').toUpperCase();
  if (!c) return 'RUB';
  return c === 'SUR' || c === 'RUR' ? 'RUB' : c;
}

function num(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null;
  return new Decimal(v).toString();
}

/**
 * Разбор страницы истории ISS в точки по датам. Чистая функция: сеть — в провайдере,
 * выбор режима, проценты номинала облигаций, НКД и множитель фьючерса — здесь, под
 * юнит-тестами на зафиксированных ответах.
 *
 * На дату может быть несколько строк (режимы торгов). Берём ту, где больше оборот VALUE
 * (там реальные сделки), при равенстве/отсутствии — основной режим. Строки без цены
 * (CLOSE пуст или 0 — «сделок не было») пропускаем.
 */
export function parseIssHistory(
  json: IssHistoryResponse,
  kind: IssHistoryKind,
  multiplier?: number,
): HistoryPoint[] {
  const section = json.history;
  if (!section) return [];
  const col = (name: string) => section.columns.indexOf(name);
  const iDate = col('TRADEDATE');
  const iBoard = col('BOARDID');
  const iValue = col('VALUE');
  const iClose = col(kind === 'forts' ? 'SETTLEPRICE' : 'CLOSE');
  const iCloseFallback = kind === 'forts' ? col('CLOSE') : -1;
  const iAcc = col('ACCINT');
  const iFace = col('FACEVALUE');
  const iFaceUnit = col('FACEUNIT');
  const iCurrencyId = col('CURRENCYID');
  if (iDate < 0 || iClose < 0) return [];

  const best = new Map<string, { rank: [number, number]; row: (string | number | null)[] }>();
  for (const row of section.data) {
    const date = row[iDate];
    const close = row[iClose] ?? (iCloseFallback >= 0 ? row[iCloseFallback] : null);
    if (typeof date !== 'string' || close === null || close === '' || Number(close) === 0) continue;
    const value = iValue >= 0 && row[iValue] !== null ? Number(row[iValue]) : -1;
    const board = iBoard >= 0 ? String(row[iBoard]) : '';
    const boardRank = MAIN_BOARDS.indexOf(board);
    const rank: [number, number] = [value, boardRank < 0 ? -1 : MAIN_BOARDS.length - boardRank];
    const cur = best.get(date);
    if (!cur || rank[0] > cur.rank[0] || (rank[0] === cur.rank[0] && rank[1] > cur.rank[1])) {
      best.set(date, { rank, row });
    }
  }

  const points: HistoryPoint[] = [];
  for (const [date, { row }] of [...best.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const close = (row[iClose] ?? (iCloseFallback >= 0 ? row[iCloseFallback] : null)) as string | number;
    if (kind === 'bonds') {
      // цена облигации — % от номинала; номинал, НКД и его валюта — из строки того же режима
      const face = iFace >= 0 ? num(row[iFace]) : null;
      if (face === null) continue;
      const acc = iAcc >= 0 ? num(row[iAcc]) : null;
      points.push({
        date,
        price: new Decimal(close).div(100).mul(face).toString(),
        currency: faceUnitToCurrency(iFaceUnit >= 0 ? row[iFaceUnit] : null),
        accruedInterest: acc,
        accruedCurrency: acc === null ? null : faceUnitToCurrency(iCurrencyId >= 0 ? row[iCurrencyId] : null),
        source: 'moex',
      });
    } else if (kind === 'forts') {
      points.push({
        date,
        // расчётная цена в пунктах → ₽ за контракт сдвигом запятой, как в отчёте брокера
        price: scaleByPowerOfTen(new Decimal(close).toString(), multiplier ?? 1),
        currency: 'RUB',
        accruedInterest: null,
        accruedCurrency: null,
        source: 'moex',
      });
    } else {
      points.push({
        date,
        price: new Decimal(close).toString(),
        currency: 'RUB',
        accruedInterest: null,
        accruedCurrency: null,
        source: 'moex',
      });
    }
  }
  return points;
}

function kindOf(target: HistoryTarget): IssHistoryKind | null {
  if (target.kind !== 'instrument') return null;
  if (target.type === 'Future') return 'forts';
  if (target.marketSource !== 'moex') return null;
  if (target.type === 'Bond') return 'bonds';
  if (target.type === 'Currency') return 'selt';
  if (target.type === 'Stock' || target.type === 'ETF') return 'shares';
  return null;
}

const PATH: Record<IssHistoryKind, string> = {
  shares: 'stock/markets/shares',
  bonds: 'stock/markets/bonds',
  selt: 'currency/markets/selt',
  forts: 'futures/markets/forts',
};

const COLUMNS: Record<IssHistoryKind, string> = {
  shares: 'TRADEDATE,BOARDID,CLOSE,VALUE',
  bonds: 'TRADEDATE,BOARDID,CLOSE,ACCINT,FACEVALUE,FACEUNIT,CURRENCYID,VALUE',
  selt: 'TRADEDATE,BOARDID,CLOSE',
  forts: 'TRADEDATE,SETTLEPRICE,CLOSE',
};

@Injectable()
export class MoexHistoryProvider implements PriceHistoryProvider {
  supports(target: HistoryTarget): boolean {
    const kind = kindOf(target);
    if (kind === 'forts') return tickerToExchangeCode(target.ticker) !== null;
    return kind !== null;
  }

  async getHistory(target: HistoryTarget, from: string, till: string): Promise<HistoryPoint[]> {
    const kind = kindOf(target);
    if (!kind) return [];
    const secid = kind === 'forts' ? tickerToExchangeCode(target.ticker) : target.ticker;
    if (!secid) return [];
    const multiplier = kind === 'forts' ? (futuresMultiplier(target.ticker) ?? undefined) : undefined;

    // страницы режутся по строкам, а не по датам: одна дата может лечь на стык страниц,
    // поэтому сначала собираем строки всех страниц и только потом выбираем лучшую на дату
    let columns: string[] = [];
    const data: (string | number | null)[][] = [];
    for (let start = 0; start < 20_000; start += PAGE) {
      const url =
        `https://iss.moex.com/iss/history/engines/${PATH[kind]}/securities/${encodeURIComponent(secid)}.json` +
        `?iss.meta=off&iss.only=history&history.columns=${COLUMNS[kind]}&from=${from}&till=${till}&start=${start}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`MOEX ISS history ${secid}: HTTP ${res.status}`);
      const section = ((await res.json()) as IssHistoryResponse).history;
      if (!section) break;
      columns = section.columns;
      data.push(...section.data);
      if (section.data.length < PAGE) break;
    }
    return parseIssHistory({ history: { columns, data } }, kind, multiplier);
  }
}
