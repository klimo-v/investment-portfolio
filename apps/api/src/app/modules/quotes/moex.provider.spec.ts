import { afterEach, describe, it, expect, vi } from 'vitest';
import { MoexProvider, parseIssQuote } from './moex.provider';

/**
 * Разбор ответа MOEX ISS на реальных формах данных (снято с биржи 13.08.2026).
 * Сеть здесь не нужна — parseIssQuote чистая, поэтому проверяем именно логику:
 * проценты номинала, приоритет ценовых колонок и выбор режима торгов.
 */

const marketdata = (rows: (string | number | null)[][]) => ({
  columns: ['SECID', 'BOARDID', 'LAST', 'LCURRENTPRICE', 'MARKETPRICE'],
  data: rows,
});
const securities = (rows: (string | number | null)[][]) => ({
  columns: ['SECID', 'BOARDID', 'FACEVALUE', 'FACEUNIT', 'ACCRUEDINT', 'CURRENCYID'],
  data: rows,
});

function shareQuote(ticker: string, board: string, currency: string | null, prices: (number | null)[]) {
  return {
    securities: { columns: ['SECID', 'BOARDID', 'CURRENCYID'], data: [[ticker, board, currency]] },
    marketdata: marketdata([[ticker, board, ...prices]]),
  };
}

describe('MOEX — основной режим акций и фондов', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['X5', 'TQBR', 'SUR', 2318.5, 'RUB'],
    ['CNYM', 'TQTY', 'CNY', 11.402, 'CNY'],
    ['NEW', 'NEWBOARD', 'USD', 12, 'USD'],
  ] as const)('запрашивает основной режим у самой биржи для %s', async (ticker, board, code, last, currency) => {
    const fetchQuote = vi.fn(async (url: string) => {
      const request = new URL(url);
      expect(request.pathname).toBe(`/iss/engines/stock/markets/shares/securities/${ticker}.json`);
      expect(request.searchParams.get('primary_board')).toBe('1');
      expect(request.searchParams.get('securities.columns')?.split(',')).toContain('CURRENCYID');
      return Response.json(shareQuote(ticker, board, code, [last, null, 140.65]));
    });
    vi.stubGlobal('fetch', fetchQuote);
    expect(await new MoexProvider().getQuote(ticker)).toMatchObject({ price: String(last), currency });
    expect(fetchQuote).toHaveBeenCalledTimes(1);
  });

  it('без сделок допускает LCURRENTPRICE в валюте режима', () => {
    const q = shareQuote('CNYM', 'TQTY', 'CNY', [null, 11.376, 140.65]);
    expect(parseIssQuote(q, 'shares')).toMatchObject({ price: '11.376', currency: 'CNY' });
  });

  it('требует единственного режима, его валюту и совпадение с описанием', () => {
    const q = shareQuote('X5', 'TQBR', 'SUR', [2318.5, null, null]);
    expect(parseIssQuote({ ...q, marketdata: marketdata([['X5', 'SPEQ', null, null, 2357], ...q.marketdata.data]) }, 'shares')).toBeNull();
    expect(parseIssQuote({ ...q, marketdata: marketdata([['X5', 'SPEQ', null, null, 2357]]) }, 'shares')).toBeNull();
    expect(parseIssQuote(shareQuote('X5', 'TQBR', null, [2318.5, null, null]), 'shares')).toBeNull();
  });

  it('не принимает рублёвый MARKETPRICE за цену в юанях', () => {
    expect(parseIssQuote(shareQuote('CNYM', 'TQTY', 'CNY', [null, null, 140.65]), 'shares')).toBeNull();
    expect(parseIssQuote(shareQuote('X5', 'TQBR', 'SUR', [null, null, null]), 'shares')).toBeNull();
  });
});

describe('parseIssQuote — облигации', () => {
  it('проценты номинала переводятся в рубли, НКД отдаётся отдельно', () => {
    const quote = parseIssQuote(
      {
        marketdata: marketdata([['SU29015RMFS3', 'TQOB', 99.26, 99.262, 99.232]]),
        securities: securities([['SU29015RMFS3', 'TQOB', 1000, 'SUR', 14.18, 'SUR']]),
      },
      'bonds',
    );
    // 99.26% от номинала 1000 ₽; у рублёвой ОФЗ FACEUNIT и CURRENCYID совпадают
    expect(quote).toEqual({
      price: '992.6',
      currency: 'RUB',
      accruedInterest: '14.18',
      accruedCurrency: 'RUB',
    });
  });

  it('индексируемый номинал ОФЗ-ИН учитывается (FACEVALUE ≠ 1000)', () => {
    const quote = parseIssQuote(
      {
        marketdata: marketdata([['SU52002RMFS1', 'TQOB', 92.276, 92.29, 92.123]]),
        securities: securities([['SU52002RMFS1', 'TQOB', 1755.47, 'SUR', 2.77, 'SUR']]),
      },
      'bonds',
    );
    expect(Number(quote?.price)).toBeCloseTo(1619.88, 2);
  });

  it('замещающая облигация: цена в валюте номинала, а НКД — в валюте расчётов', () => {
    // реальные данные TQCB: цена в USD (FACEUNIT), НКД в рублях (CURRENCYID=SUR)
    const quote = parseIssQuote(
      {
        marketdata: marketdata([['RU000A10B4K3', 'TQCB', 100.3999, 100.3963, 99.0546]]),
        securities: securities([['RU000A10B4K3', 'TQCB', 100, 'USD', 26.97024, 'SUR']]),
      },
      'bonds',
    );
    expect(Number(quote?.price)).toBeCloseTo(100.3999, 4);
    expect(quote?.currency).toBe('USD');
    expect(quote?.accruedInterest).toBe('26.97024');
    // ключевое: НКД НЕ в долларах, иначе стоимость завышается в 84 раза
    expect(quote?.accruedCurrency).toBe('RUB');
  });

  it('номинал, НКД и его валюта берутся из того же режима торгов, что и цена', () => {
    // на TQOD те же деньги выражены в долларах: 0.32 $ ≈ 26.97 ₽
    const quote = parseIssQuote(
      {
        marketdata: marketdata([
          ['RU000A10B4K3', 'TQCB', null, null, null],
          ['RU000A10B4K3', 'TQOD', 100.5, null, null],
        ]),
        securities: securities([
          ['RU000A10B4K3', 'TQCB', 100, 'USD', 26.97024, 'SUR'],
          ['RU000A10B4K3', 'TQOD', 100, 'USD', 0.32, 'USD'],
        ]),
      },
      'bonds',
    );
    expect(quote?.accruedInterest).toBe('0.32');
    expect(quote?.accruedCurrency).toBe('USD');
  });
});

describe('parseIssQuote — запасные источники цены', () => {
  it('без сделок в сессии (LAST пуст) берётся расчётная цена биржи', () => {
    const quote = parseIssQuote(
      {
        marketdata: marketdata([['SU52005RMFS4', 'TQOB', null, 101.746, 101.7]]),
        securities: securities([['SU52005RMFS4', 'TQOB', 1000, 'SUR', 8.82, 'SUR']]),
      },
      'bonds',
    );
    expect(Number(quote?.price)).toBeCloseTo(1017.46, 2);
  });

  it('MARKETPRICE — последний рубеж, когда пусты и LAST, и LCURRENTPRICE', () => {
    const quote = parseIssQuote(
      shareQuote('GOLD', 'TQTF', 'SUR', [null, null, 2.98]),
      'shares',
    );
    expect(quote?.price).toBe('2.98');
  });
});
