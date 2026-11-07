import { describe, it, expect } from 'vitest';
import { parseBrokerHtmlReport, parseBrokerHtmlReportWithMarks } from './broker-html-report';
import { normalizeRow } from '../import';
import { scaleByPowerOfTen, futuresMultiplier } from '../futures';

/**
 * Синтетический отчёт со срочными сделками: те же 14 сделок, что в реальном отчёте
 * SESPS 27.10–05.11.2026 (реальные выписки не коммитятся, .gitignore), без ПДн.
 * Формат таблиц — как в оригинале: «Срочные сделки» (12 колонок), «Срочный рынок» (10).
 */
type T = [date: string, time: string, side: string, qty: string, price: string, fb: string, fe: string, no: string];
const TRADES: T[] = [
  ['29.10.2026', '13:40:00', 'Покупка', '2', '12.27', '3.69', '1.12', '1001'],
  ['29.10.2026', '15:00:02', 'Покупка', '2', '12.284', '3.69', '1.12', '1002'],
  ['30.10.2026', '10:20:00', 'Продажа', '4', '12.328', '7.40', '2.28', '1003'],
  ['04.11.2026', '13:00:03', 'Продажа', '4', '12.357', '7.42', '2.28', '1004'],
  ['04.11.2026', '13:00:03', 'Продажа', '3', '12.357', '5.57', '1.71', '1005'],
  ['04.11.2026', '13:00:03', 'Продажа', '58', '12.357', '107.51', '33.06', '1006'],
  ['04.11.2026', '15:00:02', 'Продажа', '65', '12.34', '120.32', '37.05', '1007'],
  ['05.11.2026', '10:20:01', 'Покупка', '81', '12.467', '151.48', '46.17', '1008'],
  ['05.11.2026', '10:20:01', 'Покупка', '25', '12.467', '46.76', '14.25', '1009'],
  ['05.11.2026', '10:20:01', 'Покупка', '20', '12.467', '37.41', '11.40', '1010'],
  ['05.11.2026', '10:20:01', 'Покупка', '4', '12.467', '7.49', '2.28', '1011'],
  ['05.11.2026', '13:00:04', 'Продажа', '64', '12.421', '119.25', '36.48', '1012'],
  ['05.11.2026', '15:00:03', 'Продажа', '52', '12.42', '96.88', '29.64', '1013'],
  ['05.11.2026', '15:00:03', 'Продажа', '12', '12.42', '22.36', '6.84', '1014'],
];

const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const tradeRow = (t: T, code = 'CNY-12.26', kind = 'фьючерс') =>
  row([t[0], t[0], t[1], code, kind, t[2], t[3], t[4], t[5], t[6], t[7], '']);

function report(extraTrades = '', periodText = 'за период с 27.10.2026<br>по 05.11.2026'): string {
  return `
    <p>Договор на ведение индивидуального инвестиционного счета SESPS от 05.12.2018</p>
    <p>Отчет брокера ${periodText}</p>
    <p>Движение денежных средств за период</p>
    <table>
      ${row(['30.10.2026', 'Основной рынок', 'Зачисление вариационной маржи по CNY-12.26', 'RUB', '496.00', '0.00'])}
      ${row(['02.11.2026', 'Основной рынок', 'Списание вариационной маржи по CNY-12.26', 'RUB', '0.00', '292.00'])}
    </table>
    <p>Срочный рынок Торговый код: SESPS</p>
    <table>
      ${row(['CNY-12.26', 'фьючерс', '', '17.12.2026', '0', '', '-128', '12.387', '204.00', '-11 117.00'])}
    </table>
    <p>Срочные сделки</p>
    <table>
      ${TRADES.map((t) => tradeRow(t)).join('')}
      ${extraTrades}
    </table>`;
}

describe('parseBrokerHtmlReport — срочные сделки (фьючерсы)', () => {
  const { rows, marks } = parseBrokerHtmlReportWithMarks(report());
  const fut = rows.filter((r) => r.instrumentType === 'Future');

  it('разбирает 14 сделок, вариационную маржу из «Движения ДС» пропускает', () => {
    expect(fut).toHaveLength(14);
    expect(rows).toHaveLength(14);
    expect(fut.every((r) => !r.skipReason)).toBe(true);
  });

  it('стороны, количество, ticker как в отчёте и признак счёта', () => {
    expect(fut.filter((r) => r.tradeType === 'Покупка')).toHaveLength(6);
    expect(fut.filter((r) => r.tradeType === 'Продажа')).toHaveLength(8);
    expect(fut.reduce((s, r) => s + Number(r.quantity), 0)).toBe(396);
    expect(fut.every((r) => r.ticker === 'CNY-12.26' && r.currency === 'RUB')).toBe(true);
    expect(fut.every((r) => r.accountRef === 'SESPS' && r.accountKind === 'IIS')).toBe(true);
  });

  it('цена умножается на 1000 строкой (12.467 → 12467), без потери точности', () => {
    const r = fut.find((x) => x.brokerRef === '1008')!;
    expect(r.price).toBe('12467');
    expect(fut.find((x) => x.brokerRef === '1002')!.price).toBe('12284');
    expect(fut.find((x) => x.brokerRef === '1001')!.price).toBe('12270');
  });

  it('комиссия = брокер + биржа, номер сделки в brokerRef, время и дата сделки', () => {
    const r = fut.find((x) => x.brokerRef === '1001')!;
    expect(r.fee).toBe('4.81');
    expect(r.time).toBe('13:40:00');
    expect(r.date).toBe('29.10.2026');
    const total = fut.reduce((s, x) => s + Number(x.fee), 0);
    expect(Math.round(total * 100) / 100).toBe(962.91);
  });

  it('расчётная цена из «Срочного рынка» ×1000 на дату конца периода', () => {
    expect(marks).toEqual([{ ticker: 'CNY-12.26', date: '2026-11-05', price: '12387' }]);
  });

  it('название фьючерса содержит дату исполнения из «Срочного рынка»', () => {
    expect(fut.every((r) => r.name === 'Фьючерс CNY-12.26, исполнение 17.12.2026')).toBe(true);
  });

  it('старый вызов parseBrokerHtmlReport возвращает те же строки', () => {
    expect(parseBrokerHtmlReport(report())).toHaveLength(14);
  });

  it('нет периода в шапке → марок нет, сделки разбираются', () => {
    const r = parseBrokerHtmlReportWithMarks(report('', 'без периода'));
    expect(r.rows).toHaveLength(14);
    expect(r.marks).toEqual([]);
  });

  it('опцион и неизвестная серия не ломают разбор: строка со skipReason → ошибка normalizeRow', () => {
    const extra =
      tradeRow(TRADES[0], 'CNY-12.26', 'опцион') + tradeRow(TRADES[0], 'Si-12.26') + tradeRow(TRADES[0], 'WEIRD');
    const res = parseBrokerHtmlReport(report(extra));
    expect(res).toHaveLength(17);
    const skipped = res.filter((r) => r.skipReason);
    expect(skipped).toHaveLength(3);
    expect(skipped[0].skipReason).toContain('опцион');
    expect(skipped[1].skipReason).toContain('Si-12.26');

    const norm = normalizeRow(skipped[1], {
      resolveSystem: () => 's',
      resolvePortfolio: () => 'p',
      resolveInstrument: () => 'i',
    });
    expect('error' in norm && norm.error).toContain('Si-12.26');
  });
});

describe('срочные сделки: некорректная цена', () => {
  it('пустая цена не обрывает разбор файла: строка со skipReason, остальные разобраны', () => {
    const bad = row(['01.11.2026', '01.11.2026', '10:00:00', 'CNY-12.26', 'фьючерс', 'Покупка', '1', '', '1', '1', '9999', '']);
    const res = parseBrokerHtmlReport(report(bad));
    expect(res).toHaveLength(15);
    expect(res.filter((r) => r.skipReason)).toHaveLength(1);
    expect(res.find((r) => r.skipReason)?.skipReason).toContain('цену');
  });
});

describe('futures: множитель и сдвиг запятой', () => {
  it('scaleByPowerOfTen', () => {
    expect(scaleByPowerOfTen('12.467', 1000)).toBe('12467');
    expect(scaleByPowerOfTen('12.27', 1000)).toBe('12270');
    expect(scaleByPowerOfTen('12', 1000)).toBe('12000');
    expect(scaleByPowerOfTen('0.0005', 1000)).toBe('0.5');
    expect(scaleByPowerOfTen('0.5', 1000)).toBe('500');
    expect(scaleByPowerOfTen('12.4678', 1000)).toBe('12467.8');
    expect(scaleByPowerOfTen('-1.5', 1000)).toBe('-1500');
    expect(() => scaleByPowerOfTen('1', 7)).toThrow();
  });
  it('futuresMultiplier: известная и неизвестная серия', () => {
    expect(futuresMultiplier('CNY-12.26')).toBe(1000);
    expect(futuresMultiplier('Si-12.26')).toBeNull();
    expect(futuresMultiplier('GLDRUB_TOM')).toBeNull();
  });
});
