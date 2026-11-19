import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MoexHistoryProvider, parseIssHistory, type IssHistoryResponse } from './moex-history.provider';
import { CbrHistoryProvider } from './cbr-history.provider';
import { BinanceHistoryProvider } from './binance-history.provider';
import type { HistoryTarget } from './price-history.provider';
import { parseCbrDynamic } from './cbr-history.provider';
import { parseKlines } from './binance-history.provider';

/** Зафиксированные ответы ISS / ЦБ / Binance — без сети (как moex.provider.spec.ts) */
const fixture = (name: string): string => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
const iss = (name: string) => JSON.parse(fixture(name)) as IssHistoryResponse;

describe('MOEX ISS history: акции', () => {
  it('CLOSE в рублях по датам торгов SBER', () => {
    const points = parseIssHistory(iss('iss-shares-sber.json'), 'shares');
    expect(points.map((p) => [p.date, p.price])).toEqual([
      ['2026-10-28', '297.98'],
      ['2026-10-29', '295.08'],
      ['2026-10-30', '296.25'],
      ['2026-11-02', '290.8'],
      ['2026-11-03', '292.17'],
      ['2026-11-05', '292.43'],
    ]);
    expect(points[0]).toMatchObject({ currency: 'RUB', accruedInterest: null, source: 'moex' });
  });

  it('сравнивает режимы по количеству бумаг и сохраняет валюту выбранного закрытия', () => {
    const columns = ['TRADEDATE', 'BOARDID', 'CLOSE', 'VOLUME', 'NUMTRADES', 'CURRENCYID'];
    const rows = [
      ['2026-11-16', 'BOARD1', 140, 90, 3, 'SUR'],
      ['2026-11-16', 'BOARD2', 11, 120, 4, 'CNY'],
      ['2026-11-16', 'BOARD3', 99, 200, 5, null],
      ['2026-11-17', 'BOARD1', 141, 130, 2, 'SUR'],
    ];
    for (const data of [rows, [...rows].reverse()]) {
      const points = parseIssHistory({ history: { columns, data } }, 'shares');
      expect(points.map((p) => [p.price, p.currency])).toEqual([['11', 'CNY'], ['141', 'RUB']]);
    }
  });
});

describe('MOEX ISS history: облигации', () => {
  it('ОФЗ: цена — % номинала × FACEVALUE, НКД на дату в рублях', () => {
    const [p] = parseIssHistory(iss('iss-bonds-ofz.json'), 'bonds');
    // 101.597% от 1000 ₽
    expect(p).toMatchObject({
      date: '2026-11-02',
      price: '1015.97',
      currency: 'RUB',
      accruedInterest: '11.07',
      accruedCurrency: 'RUB',
    });
  });

  it('замещающая: цена в USD (номинал), НКД в рублях — берётся из строки режима с оборотом (TQCB)', () => {
    const points = parseIssHistory(iss('iss-bonds-usd.json'), 'bonds');
    expect(points).toHaveLength(2); // режим TQOD без сделок (CLOSE=null) пропущен
    expect(points[0]).toMatchObject({
      date: '2026-11-03',
      price: '100.1299',
      currency: 'USD',
      accruedInterest: '38.0575',
      accruedCurrency: 'RUB',
    });
  });
});

describe('MOEX ISS history: фьючерс и валюта', () => {
  it('фьючерс: расчётная цена в пунктах × множитель серии = ₽ за контракт', () => {
    const points = parseIssHistory(iss('iss-forts-crz6.json'), 'forts', 1000);
    expect(points.map((p) => p.price)).toEqual(['12414', '12375', '12387']);
    expect(points[0].currency).toBe('RUB');
  });

  it('валюта SELT: нулевые режимы (CLOSE=0) пропущены, без VALUE выигрывает основной режим CETS', () => {
    const points = parseIssHistory(iss('iss-selt-gld.json'), 'selt');
    expect(points.map((p) => [p.date, p.price])).toEqual([
      ['2026-11-02', '10442'],
      ['2026-11-03', '10367'],
      ['2026-11-05', '10730.5'],
    ]);
  });

  it('пустой или неожиданный ответ — пустой ряд, не исключение', () => {
    expect(parseIssHistory({}, 'shares')).toEqual([]);
    expect(parseIssHistory({ history: { columns: ['X'], data: [[1]] } }, 'bonds')).toEqual([]);
  });
});

describe('ЦБ РФ: история курса', () => {
  it('Value / Nominal, дата dd.mm.yyyy → ISO, запятая как десятичный разделитель', () => {
    const points = parseCbrDynamic(fixture('cbr-usd.xml'));
    expect(points.map((p) => [p.date, p.price])).toEqual([
      ['2026-11-03', '80.9734'],
      ['2026-11-04', '81.6699'],
      ['2026-11-06', '81.7947'],
    ]);
    expect(points[0]).toMatchObject({ currency: 'RUB', source: 'cbr' });
  });

  it('номинал > 1 (например, 100 единиц) делится на номинал', () => {
    const xml = '<ValCurs><Record Date="03.11.2026" Id="X"><Nominal>100</Nominal><Value>12,5</Value></Record></ValCurs>';
    expect(parseCbrDynamic(xml)[0].price).toBe('0.125');
  });
});

describe('Binance klines', () => {
  it('цена закрытия дня, дата — по UTC открытия свечи, валюта USD', () => {
    const points = parseKlines(JSON.parse(fixture('binance-btc-klines.json')));
    expect(points[0]).toMatchObject({ date: '2026-11-04', price: '80504.01', currency: 'USD', source: 'binance' });
    expect(points.length).toBeGreaterThanOrEqual(2);
  });
});


/**
 * Фикстура индекса составлена ВРУЧНУЮ в формате ответа ISS (history/engines/stock/markets/index/
 * securities/{SECID}.json, колонки TRADEDATE, CLOSE) — без сети живой ответ не снимался.
 */
describe('MOEX ISS history: индексы', () => {
  it('CLOSE как есть, валюта IDX; нулевые и пустые закрытия пропускаются', () => {
    const points = parseIssHistory(iss('iss-index-history.json'), 'index');
    expect(points.map((p) => [p.date, p.price])).toEqual([
      ['2026-10-30', '12000.5'],
      ['2026-11-02', '12060.55'],
      ['2026-11-06', '12120.6'],
    ]);
    expect(points[0]).toMatchObject({ currency: 'IDX', accruedInterest: null, source: 'moex' });
  });

  it('индексы обслуживает только MOEX-провайдер', () => {
    const idx: HistoryTarget = { instrumentId: 'index:MCFTRR', ticker: 'MCFTRR', kind: 'index', type: 'Index', currency: 'IDX', marketSource: 'moex' };
    expect(new MoexHistoryProvider().supports(idx)).toBe(true);
    expect(new CbrHistoryProvider().supports(idx)).toBe(false);
    expect(new BinanceHistoryProvider().supports(idx)).toBe(false);
  });
});
