import { describe, it, expect } from 'vitest';
import { parseBrokerHtmlReport } from './broker-html-report';

const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const cells16 = (p: Record<number, string>): string[] =>
  Array.from({ length: 16 }, (_, i) => p[i] ?? '');

const html = (isin: string) => `
  <p>Справочник Ценных Бумаг</p>
  <table>${row(['Сбербанк', 'SBER', isin, 'ПАО Сбербанк', 'Акция обыкновенная', '1'])}</table>
  <p>Сделки</p>
  <table>${row(cells16({ 0: '07.07.2026', 4: 'SBER', 5: 'RUB', 6: 'Покупка', 7: '10', 8: '300', 11: '1', 12: '1', 13: '5001' }))}</table>`;

describe('HTML-отчёт: ISIN из «Справочника ЦБ» уходит в identifiers', () => {
  it('валидный ISIN попадает в identifiers.isin, тикер остаётся тикером', () => {
    const [r] = parseBrokerHtmlReport(html('RU0009029540'));
    expect(r.ticker).toBe('SBER');
    expect(r.identifiers).toEqual({ isin: 'RU0009029540' });
  });

  it('строка справочника с невалидным ISIN не считается справочником', () => {
    const [r] = parseBrokerHtmlReport(html('RU0009029541'));
    expect(r.identifiers).toBeUndefined();
  });
});
