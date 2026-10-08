import { describe, it, expect } from 'vitest';
import { parseIssQuote } from './moex.provider';

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

describe('parseIssQuote — акции и фонды', () => {
  it('цена берётся как есть, без пересчёта номинала', () => {
    const quote = parseIssQuote(
      { marketdata: marketdata([['SBMM', 'TQTF', 19.16, 19.16, 19.15]]) },
      false,
    );
    expect(quote).toEqual({
      price: '19.16',
      currency: 'RUB',
      accruedInterest: null,
      accruedCurrency: null,
    });
  });

  it('нет ни одной ценовой колонки — цены нет', () => {
    expect(parseIssQuote({ marketdata: marketdata([['X', 'TQBR', null, null, null]]) }, false)).toBeNull();
    expect(parseIssQuote({}, false)).toBeNull();
  });
});

describe('parseIssQuote — облигации', () => {
  it('проценты номинала переводятся в рубли, НКД отдаётся отдельно', () => {
    const quote = parseIssQuote(
      {
        marketdata: marketdata([['SU29015RMFS3', 'TQOB', 99.26, 99.262, 99.232]]),
        securities: securities([['SU29015RMFS3', 'TQOB', 1000, 'SUR', 14.18, 'SUR']]),
      },
      true,
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
      true,
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
      true,
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
      true,
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
      true,
    );
    expect(Number(quote?.price)).toBeCloseTo(1017.46, 2);
  });

  it('MARKETPRICE — последний рубеж, когда пусты и LAST, и LCURRENTPRICE', () => {
    const quote = parseIssQuote(
      { marketdata: marketdata([['GOLD', 'TQTF', null, null, 2.98]]) },
      false,
    );
    expect(quote?.price).toBe('2.98');
  });
});
