import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { parseTbankXlsx } from './tbank-xlsx-report';
import type { RawRow } from '@core';

/**
 * Тест парсера xlsx-отчёта Т-Банка на реальном отчёте пользователя
 * (27.04.2025–21.07.2026). Реальные выписки содержат ПДн и не коммитятся
 * (см. .gitignore) — если фикстуры нет (CI/другая машина), тест skipped.
 * Файл читается ОДИН раз в beforeAll (~1200 строк, разбор не быстрый) и
 * переиспользуется всеми проверками, а не заново на каждый `it`.
 */

const fixture = fileURLToPath(new URL('./__fixtures__/tbank-report.xlsx', import.meta.url));
const hasFixture = existsSync(fixture);

let rows: RawRow[] = [];

describe.skipIf(!hasFixture)('parseTbankXlsx — реальный отчёт Т-Банка', () => {
  beforeAll(async () => {
    const workbook = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(readFileSync(fixture) as any);
    rows = parseTbankXlsx(workbook.worksheets[0]);
  }, 60_000); // реальный файл ~1200 строк — разбор дольше дефолтных 10с

  it('извлекает все сделки раздела 1.1: 788 Покупка + 134 Продажа = 922', () => {
    const trades = rows.filter((r) => r.tradeType === 'Покупка' || r.tradeType === 'Продажа');
    expect(trades).toHaveLength(922);
    expect(trades.filter((r) => r.tradeType === 'Покупка')).toHaveLength(788);
    expect(trades.filter((r) => r.tradeType === 'Продажа')).toHaveLength(134);
  });

  it('brokerRef уникален на каждую сделку (иначе дедуп по хэшу схлопывает разные сделки в «дубль»)', () => {
    // 876 сделок TMON@ в реальном файле — многие с одинаковыми date/qty/price
    // (регулярный автоинвест), без brokerRef хэш-дедуп ложно считал бы их дублями
    const trades = rows.filter((r) => r.tradeType === 'Покупка' || r.tradeType === 'Продажа');
    expect(trades.every((r) => !!r.brokerRef)).toBe(true);
    expect(new Set(trades.map((r) => r.brokerRef)).size).toBe(trades.length);
  });

  it('цена облигации переводится из % номинала в реальную (Сумма сделки / Количество)', () => {
    // ОФЗ 52003, 06.07.2026: 20 шт., Сумма сделки 26864.59 → цена 1343.2295, комиссия 13.25
    const bond = rows.find((r) => r.ticker === 'SU52003RMFS9' && r.date === '06.07.2026')!;
    expect(bond).toBeDefined();
    expect(bond.quantity).toBe('20');
    expect(bond.price).toBe('1343.2295');
    expect(bond.fee).toBe('13.25');
    expect(bond.instrumentType).toBe('Bond');
  });

  it('акция, проведённая по ISIN вместо тикера (Сбербанк на отдельной площадке)', () => {
    const row = rows.find((r) => r.ticker === 'RU0009029540' && r.date === '14.09.2025')!;
    expect(row).toBeDefined();
    expect(row.quantity).toBe('188');
    expect(row.price).toBe('303.65'); // 57086.2 / 188, совпадает с «Цена за единицу» — не бонд
    expect(row.fee).toBe('22.83');
  });

  it('тикер денежного фонда без суффикса "@" (TMON@ → TMON)', () => {
    expect(rows.some((r) => r.ticker === 'TMON')).toBe(true);
    expect(rows.some((r) => r.ticker === 'TMON@')).toBe(false);
  });

  it('депозиты (Пополнение счета): 3 штуки, 605775 + 400000 + 25000', () => {
    const deposits = rows.filter((r) => r.tradeType === 'Deposit');
    expect(deposits).toHaveLength(3);
    const sum = deposits.reduce((s, d) => s + Number(d.price), 0);
    expect(sum).toBeCloseTo(1030775, 2);
  });

  it('дивиденд сворачивается в одну нетто-операцию (брутто 11270 − налог 1466 = 9804)', () => {
    const dividends = rows.filter((r) => r.tradeType === 'Dividend');
    expect(dividends).toHaveLength(1); // не 2 (брутто+налог отдельно), а одна нетто
    expect(dividends[0].ticker).toBe('RU000A108X38'); // ISIN — тикера у выплаты нет
    expect(dividends[0].price).toBe('9804');
    // отдельной Tax-операции по этой выплате быть не должно (свёрнута внутрь)
    expect(rows.filter((r) => r.tradeType === 'Tax')).toHaveLength(0);
  });

  it('не тянет денежный хвост сделок из раздела 2 (Покупка/продажа, Комиссия за сделки, DFP/RFP)', () => {
    const trades = rows.filter((r) => r.tradeType === 'Покупка' || r.tradeType === 'Продажа');
    const cashOnly = rows.length - trades.length; // депозиты + дивиденд
    expect(cashOnly).toBe(4); // 3 депозита + 1 дивиденд-нетто, без хвостов и DFP/RFP
  });
});

/**
 * Синтетические тесты механизма (без реального файла): строим xlsx в памяти той
 * же структуры (маркеры разделов «1.1 …» / «2. …», заголовки таблиц) — проверяем
 * логику независимо от того, есть ли фикстура. Полезно для случая, которого нет
 * в реальном отчёте пользователя — например, купон вместо дивиденда.
 */
async function buildSyntheticWorkbook(): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('rep');

  ws.getCell(1, 1).value = '1.1 Информация о совершенных и исполненных сделках на конец отчетного периода';
  ws.getCell(2, 1).value = 'Номер сделки'; // строка заголовков — пропускается парсером

  // одна сделка: покупка ETF, простая (не бонд, не ISIN)
  const r = 3;
  ws.getCell(r, 1).value = '111';
  ws.getCell(r, 9).value = '01.02.2026';
  ws.getCell(r, 16).value = 'Покупка';
  ws.getCell(r, 18).value = 'паи БПИФ рфи Т-КапиталДенРынок';
  ws.getCell(r, 20).value = 'TMON@';
  ws.getCell(r, 27).value = 5;
  ws.getCell(r, 35).value = 500;
  ws.getCell(r, 39).value = 'RUB';
  ws.getCell(r, 40).value = 1;
  ws.getCell(r, 46).value = 0;
  ws.getCell(r, 51).value = 0;

  ws.getCell(5, 1).value = '2. Операции с денежными средствами';
  ws.getCell(6, 1).value = 'Дата';
  ws.getCell(6, 38).value = 'Операция';

  // купон: брутто + налог, разные суммы — проверяем нетто и что тип = Coupon
  ws.getCell(7, 1).value = '10.02.2026';
  ws.getCell(7, 23).value = '10.02.2026';
  ws.getCell(7, 38).value = 'Выплата доходов по корпоративным действиям';
  ws.getCell(7, 53).value = 1000;
  ws.getCell(7, 77).value = 'Тип КД: Выплата купона, Наименование: ОФЗ, ISIN: RU000TEST001, Валюта:RUB';

  ws.getCell(8, 1).value = '10.02.2026';
  ws.getCell(8, 23).value = '10.02.2026';
  ws.getCell(8, 38).value = 'Налог (купоны)';
  ws.getCell(8, 66).value = 130;
  ws.getCell(8, 77).value = 'Наименование: ОФЗ, ISIN: RU000TEST001, Валюта:RUB';

  ws.getCell(9, 1).value = '3.1 Движение по ценным бумагам инвестора'; // конец раздела 2

  return ws;
}

describe('parseTbankXlsx — синтетический документ (купон, без реального файла)', () => {
  it('купон брутто 1000 − налог 130 = 870, тип Coupon, тикер = ISIN', async () => {
    const ws = await buildSyntheticWorkbook();
    const rows = parseTbankXlsx(ws);

    const trade = rows.find((r) => r.ticker === 'TMON');
    expect(trade?.tradeType).toBe('Покупка');
    expect(trade?.price).toBe('100'); // 500 / 5

    const coupon = rows.find((r) => r.tradeType === 'Coupon');
    expect(coupon).toBeDefined();
    expect(coupon?.ticker).toBe('RU000TEST001');
    expect(coupon?.price).toBe('870');
    expect(rows.filter((r) => r.tradeType === 'Tax')).toHaveLength(0);
  });
});
