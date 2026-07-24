import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseBrokerHtmlReport } from './broker-html-report';
import type { RawRow } from '../import';

/**
 * Тест парсера на реальном отчёте пользователя (SESPS, период 01.07–22.07.2026).
 * Проверяем на точных цифрах из файла (CLAUDE.md §10 — приоритет финансовой логике).
 *
 * Реальные выписки содержат ПДн и не коммитятся (см. .gitignore). Если фикстуры
 * нет (CI/другая машина) — тест помечается skipped, а не падает.
 */

const fixture = fileURLToPath(new URL('./__fixtures__/sesps-report.html', import.meta.url));
const hasFixture = existsSync(fixture);
const rows = hasFixture ? parseBrokerHtmlReport(readFileSync(fixture, 'utf-8')) : [];
const find = (p: (r: RawRow) => boolean) => rows.filter(p);
const buysSells = find((r) => r.tradeType === 'Покупка' || r.tradeType === 'Продажа');

describe.skipIf(!hasFixture)('parseBrokerHtmlReport — отчёт SESPS', () => {
  it('извлекает ровно 12 операций: 8 сделок ЦБ + 1 валютная (GLDRUB_TOM) + 3 денежных (дивиденд, 2 депозита)', () => {
    expect(rows).toHaveLength(12);
    expect(buysSells).toHaveLength(9); // 8 ЦБ + 1 GLDRUB_TOM
    expect(find((r) => r.tradeType === 'Dividend')).toHaveLength(1);
    expect(find((r) => r.tradeType === 'Deposit')).toHaveLength(2);
  });

  it('сделки ЦБ: тикер, вид, количество, цена и суммарная комиссия (Брокера+Биржи)', () => {
    // Продажа SBMM 5 000 @ 18.887, комиссия биржи 9.44
    const sbmmSell = find((r) => r.ticker === 'SBMM' && r.tradeType === 'Продажа');
    expect(sbmmSell).toHaveLength(2); // 07.07 (5000) и 15.07 (1500)
    const s0707 = sbmmSell.find((r) => r.date === '07.07.2026')!;
    expect(s0707.quantity).toBe('5000');
    expect(s0707.price).toBe('18.887');
    expect(s0707.fee).toBe('9.44');
    expect(s0707.currency).toBe('RUB');
    expect(s0707.instrumentType).toBe('ETF'); // Фонд Сберегательный = биржевой фонд

    // Покупка SBER 100 @ 292, комиссия брокера 17.52
    const sber = find((r) => r.ticker === 'SBER' && r.tradeType === 'Покупка' && r.quantity === '100')[0];
    expect(sber.price).toBe('292');
    expect(sber.fee).toBe('17.52');
    expect(sber.instrumentType).toBe('Stock');
  });

  it('валютная сделка GLDRUB_TOM: полный тикер (не усечённый до GLD), кол-во 10, цена 10075, комиссия брокера 604.5', () => {
    const gld = find((r) => r.ticker === 'GLDRUB_TOM')[0];
    expect(gld.tradeType).toBe('Покупка');
    expect(gld.date).toBe('16.07.2026');
    expect(gld.quantity).toBe('10.00');
    expect(gld.price).toBe('10075');
    expect(gld.fee).toBe('604.5');
    expect(gld.instrumentType).toBe('Currency');
    expect(gld.currency).toBe('RUB');
  });

  it('дивиденд X5 3624.00 — тикер резолвится по имени из Справочника ЦБ', () => {
    const div = find((r) => r.tradeType === 'Dividend')[0];
    expect(div.ticker).toBe('X5'); // «Корп центр ИКС 5» → X5
    expect(div.date).toBe('20.07.2026');
    expect(div.price).toBe('3624.00');
    expect(div.quantity).toBe('1');
  });

  it('депозиты (зачисления д/с) 330030 и 19987 берутся из движения ДС', () => {
    const deposits = find((r) => r.tradeType === 'Deposit').map((r) => r.price).sort();
    expect(deposits).toEqual(['19987.00', '330030.00'].sort());
  });

  it('не тянет денежные хвосты сделок и комиссии из «Движения ДС» (нет двойного счёта)', () => {
    // все Покупки/Продажи имеют тикер (пришли из таблиц сделок, а не из движения ДС)
    expect(buysSells.every((r) => !!r.ticker)).toBe(true);
    // строки «Сделка от…»/«Комиссия…» не попали как отдельные операции
    expect(find((r) => (r.note ?? '').includes('Комиссия'))).toHaveLength(0);
  });

  it('признак счёта (§3.1): все строки помечены ИИС SESPS из шапки договора', () => {
    expect(rows.every((r) => r.accountRef === 'SESPS')).toBe(true);
    expect(rows.every((r) => r.accountKind === 'IIS')).toBe(true);
  });
});

/**
 * Синтетический тест механизма последовательного обхода документа (§3.1): один
 * файл может содержать операции РАЗНЫХ счетов брокера (обычный ↔ ИИС) — здесь
 * нет реального образца с двумя счетами, поэтому проверяем сам механизм —
 * маркер счёта в тексте между таблицами должен переключать accountRef/accountKind
 * для всех последующих строк, а не применяться ко всему документу разом.
 */
function securityTradeRow(date: string, ticker: string, tradeType: 'Покупка' | 'Продажа'): string {
  // 16 колонок, «Вид» на индексе 6 — минимально достаточные для securityTradeRows
  const cells = [date, date, '10:00:00', ticker, ticker, 'RUB', tradeType, '1', '100', '100', '0', '0', '0', '1', '', 'ЗИ'];
  return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
}

describe('parseBrokerHtmlReport — синтетический документ с двумя счетами', () => {
  const html = `
    <p>Договор на ведение индивидуального инвестиционного счета SESPS от 05.12.2018</p>
    <table>${securityTradeRow('01.01.2026', 'AAA', 'Покупка')}</table>
    <p>Договор на брокерское обслуживание счет BROK1</p>
    <table>${securityTradeRow('02.01.2026', 'BBB', 'Продажа')}</table>
  `;
  const rows = parseBrokerHtmlReport(html);

  it('строки до второго маркера помечены первым счётом (ИИС SESPS)', () => {
    const aaa = rows.find((r) => r.ticker === 'AAA')!;
    expect(aaa.accountRef).toBe('SESPS');
    expect(aaa.accountKind).toBe('IIS');
  });

  it('строки после второго маркера переключаются на новый счёт (брокерский BROK1)', () => {
    const bbb = rows.find((r) => r.ticker === 'BBB')!;
    expect(bbb.accountRef).toBe('BROK1');
    expect(bbb.accountKind).toBe('Brokerage');
  });
});
