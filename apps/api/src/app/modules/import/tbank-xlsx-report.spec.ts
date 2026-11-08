import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { parseTbankXlsx } from './tbank-xlsx-report';
import { mapTbankOperations, normalizeRawRows, type RawRow } from '@core';

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
    // ignoreNodes: mergeCells — см. import.service.ts, тот же разбор без него ~30с
    await workbook.xlsx.load(readFileSync(fixture) as any, { ignoreNodes: ['mergeCells'] });
    rows = parseTbankXlsx(workbook.worksheets[0]);
  }, 10_000);

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

  it('цена облигации переводится из % номинала в реальную БЕЗ учёта НКД (Сумма без НКД / Количество)', () => {
    // ОФЗ 52003, 06.07.2026: 20 шт., Сумма без НКД 26500.19 → цена 1325.0095, комиссия 13.25.
    // НЕ «Сумма сделки» (с НКД) — иначе цена покупки задрана относительно чистой
    // текущей котировки MOEX, и P&L систематически занижен (см. пояснение в парсере).
    const bond = rows.find((r) => r.ticker === 'SU52003RMFS9' && r.date === '06.07.2026')!;
    expect(bond).toBeDefined();
    expect(bond.quantity).toBe('20');
    expect(bond.price).toBe('1325.0095');
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

  it('парсер отдаёт код как в отчёте (TMON@), а срезает «@» общий шаг нормализации импорта', () => {
    expect(rows.some((r) => r.ticker === 'TMON@')).toBe(true);
    const normalized = normalizeRawRows(rows);
    expect(normalized.some((r) => r.ticker === 'TMON')).toBe(true);
    expect(normalized.some((r) => r.ticker === 'TMON@')).toBe(false);
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
    expect(dividends[0].ticker).toBeUndefined(); // тикера у выплаты нет — только ISIN
    expect(dividends[0].identifiers).toEqual({ isin: 'RU000A108X38' });
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
  ws.getCell(r, 29).value = 500; // Сумма без НКД — то, из чего теперь считается цена
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
  it('купон брутто 1000 − налог 130 = 870, тип Coupon, ISIN отдельным идентификатором', async () => {
    const ws = await buildSyntheticWorkbook();
    const rows = parseTbankXlsx(ws);

    const trade = rows.find((r) => r.ticker === 'TMON@');
    expect(trade?.tradeType).toBe('Покупка');
    expect(trade?.price).toBe('100'); // 500 / 5

    const coupon = rows.find((r) => r.tradeType === 'Coupon');
    expect(coupon).toBeDefined();
    expect(coupon?.ticker).toBeUndefined();
    expect(coupon?.identifiers).toEqual({ isin: 'RU000TEST001' });
    expect(coupon?.price).toBe('870');
    expect(rows.filter((r) => r.tradeType === 'Tax')).toHaveLength(0);
  });
});

/** Раздел 2 из заданных строк: [дата, время, операция, зачисление, списание, примечание] с блоками по валютам */
function buildCashWorkbook(blocks: Record<string, Array<[string, string, string, number, number, string?]>>): ExcelJS.Worksheet {
  const ws = new ExcelJS.Workbook().addWorksheet('rep');
  ws.getCell(1, 1).value = '2. Операции с денежными средствами';
  let r = 2;
  for (const [currency, items] of Object.entries(blocks)) {
    ws.getCell(r++, 1).value = currency;
    ws.getCell(r, 1).value = 'Дата';
    ws.getCell(r, 38).value = 'Операция';
    r++;
    for (const [date, time, op, credit, debit, note] of items) {
      ws.getCell(r, 1).value = date;
      ws.getCell(r, 11).value = time;
      ws.getCell(r, 23).value = date;
      ws.getCell(r, 38).value = op;
      ws.getCell(r, 53).value = credit;
      ws.getCell(r, 66).value = debit;
      if (note) ws.getCell(r, 77).value = note;
      r++;
    }
  }
  ws.getCell(r, 1).value = '3.1 Движение по ценным бумагам инвестора';
  return ws;
}

describe('parseTbankXlsx — паритет с API: налоги без ISIN, возвраты, комиссия, валюта и время (синтетика)', () => {
  const rows = parseTbankXlsx(
    buildCashWorkbook({
      RUB: [
        ['02.05.2025', '11:14:29', 'Пополнение счета', 1000, 0],
        ['06.05.2025', '10:00:00', 'Корректировка налога', 2689, 0], // возврат
        ['06.05.2025', '10:00:01', 'Корректировка налога', 0, 2689], // повторное удержание
        ['07.05.2025', '09:00:00', 'Налог на доход', 0, 500], // налог без ISIN
        ['22.07.2026', '04:00:00', 'Списание комиссии за обслуживание', 0, 390],
        ['22.07.2026', '04:00:01', 'Комиссия за сделки', 0, 9.51], // хвост сделки — пропускается
      ],
      CNY: [['04.09.2024', '07:10:00', 'Пополнение счета', 19860.18, 0]],
    }),
  );
  const byType = (t: string) => rows.filter((r) => r.tradeType === t);

  it('возврат налога — Tax с отрицательной суммой, удержание — положительной (как у API)', () => {
    expect(byType('Tax').map((r) => r.price)).toEqual(['-2689', '2689', '500']);
    expect(byType('Tax')[0].note).toContain('возврат');
  });

  it('комиссия обслуживания — Fee; «Комиссия за сделки» не тянется', () => {
    expect(byType('Fee').map((r) => r.price)).toEqual(['390']);
  });

  it('валюта берётся из блока раздела, время — из «Время совершения»', () => {
    const [rubDep, cnyDep] = byType('Deposit');
    expect(rubDep.currency).toBe('RUB');
    expect(rubDep.time).toBe('11:14:29');
    expect(cnyDep.currency).toBe('CNY');
    expect(cnyDep.price).toBe('19860.18');
  });

  it('те же суммы и знаки, что у API-маппера для тех же операций', () => {
    const item = (id: string, type: string, units: string) => ({
      id, date: '2025-05-06T07:00:00Z', type: `OPERATION_TYPE_${type}`, state: 'OPERATION_STATE_EXECUTED', payment: { currency: 'rub', units, nano: 0 },
    });
    const api = mapTbankOperations(
      [item('a', 'TAX_CORRECTION', '2689'), item('b', 'TAX_CORRECTION', '-2689'), item('c', 'TAX', '-500'), item('d', 'SERVICE_FEE', '-390')],
      'acc',
    );
    expect(api.map((r) => [r.tradeType, r.price])).toEqual([
      ['tax', '-2689'],
      ['tax', '2689'],
      ['tax', '500'],
      ['fee', '390'],
    ]);
  });
});
