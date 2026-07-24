import type ExcelJS from 'exceljs';
import Decimal from 'decimal.js';
import type { RawRow } from '@core';

/**
 * Парсер xlsx-отчёта брокера Т-Банк («Отчет о сделках и операциях», разделы
 * 1.1 «Совершённые и исполненные сделки» + 2. «Операции с денежными
 * средствами») в RawRow[] — тот же контракт, что и остальные парсеры (Strategy,
 * CLAUDE.md §7). Разбор конкретной таблицы (exceljs) — на бэке (не в libs/core,
 * чтобы не тащить Node-библиотеку в бандл фронта).
 *
 * Осознанные решения:
 *  - Секции ищутся по маркерам «N.M …» в колонке A, а не по фиксированным номерам
 *    строк — расположение сдвигается от периода к периоду.
 *  - Цена облигаций в отчёте — в % от номинала («Валюта цены» = '%'), это НЕ
 *    цена за единицу в деньгах. Берём фактическую цену как
 *    (Сумма сделки) / Количество — общая формула, верная и для акций/фондов
 *    (для них совпадает с «Цена за единицу» дословно).
 *  - Комиссия = Комиссия брокера + биржи + клир. центра + гербовый сбор.
 *  - «Покупка/продажа», «Комиссия за сделки», «DFP/RFP» в разделе 2 — денежный
 *    хвост уже учтённых сделок (проверено на реальных цифрах: суммы DFP/RFP
 *    совпадают с расчётами по конкретным сделкам ISIN-кодом) — пропускаем.
 *  - Дивиденд репортится ДВУМЯ строками (брутто + «Налог (дивиденды)»,
 *    привязанные к одной выплате по ISIN + дате исполнения) — сворачиваем в
 *    одну Dividend-операцию на нетто-сумму (решение пользователя).
 *  - У выплаты нет тикера, только ISIN в примечании — кладём ISIN в `ticker`,
 *    резолвер инструмента подхватит через фоллбэк по `instruments.isin`.
 */

const TRADE_KINDS = new Set(['Покупка', 'Продажа']);
const ISIN_RE = /ISIN:\s*([A-Z0-9]{12})/;
const KD_TYPE_RE = /Тип КД:\s*Выплата\s+(дивидендов|купон\w*)/i;
const KD_REF_RE = /Референс КД:\s*(\d+)/;

/** Колонки раздела «1.1 Сделки» (1-based, см. заголовок отчёта) */
const TRADE_COL = {
  tradeNo: 1,
  date: 9,
  kind: 16,
  name: 18,
  ticker: 20,
  settleCcy: 39,
  qty: 27,
  tradeAmount: 35,
  brokerFee: 40,
  exchangeFee: 46,
  clearingFee: 51,
  stampDuty: 58,
};

/** Колонки раздела «2. Операции с денежными средствами» */
const CASH_COL = {
  date: 1,
  settleDate: 23,
  operation: 38,
  credit: 53,
  debit: 66,
  note: 77,
};

function cellValue(ws: ExcelJS.Worksheet, row: number, col: number): unknown {
  return ws.getCell(row, col).value;
}

/** Фрагмент rich-text ячейки exceljs ({richText: [{text, font}, ...]}) */
interface RichTextFragment {
  text: string;
}

function cellText(ws: ExcelJS.Worksheet, row: number, col: number): string {
  const v = cellValue(ws, row, col);
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    // Т-Банк форматирует многие ячейки разными шрифтами внутри одной ячейки
    // (напр. жирный префикс + обычный текст) — exceljs отдаёт это как richText,
    // а не строку; собираем фрагменты обратно в одну строку.
    if (Array.isArray(obj['richText'])) {
      return (obj['richText'] as RichTextFragment[]).map((f) => f.text ?? '').join('').trim();
    }
    if ('result' in obj) return String(obj['result'] ?? '').trim();
  }
  return String(v).trim();
}

function cellNum(ws: ExcelJS.Worksheet, row: number, col: number): number {
  const v = cellValue(ws, row, col);
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

interface SectionMarker {
  row: number;
  label: string;
}

/**
 * Маркеры разделов в колонке A, в порядке появления. Два формата в одном отчёте:
 * «N.M …» (подразделы, напр. «1.1 Информация…») и «N. …» (верхнеуровневые, напр.
 * «2. Операции с денежными средствами» — без второго числа после точки).
 */
function findSectionMarkers(ws: ExcelJS.Worksheet): SectionMarker[] {
  const markers: SectionMarker[] = [];
  const rowCount = ws.rowCount;
  for (let r = 1; r <= rowCount; r++) {
    const v = cellText(ws, r, 1);
    if (/^\d+(\.\d+)*\.?\s/.test(v)) {
      markers.push({ row: r, label: v });
    }
  }
  return markers;
}

/** Убрать суффикс "@" у кодов вида "TMON@" (маркер денежных фондов у Т-Банка) */
function normalizeTicker(code: string): string {
  return code.replace(/@+$/, '');
}

/** Эвристика типа инструмента по названию/коду (аналог broker-html-report.ts) */
function instrumentTypeFromName(name: string, ticker: string): string {
  const n = name.toLowerCase();
  if (n.includes('офз') || /^SU\d/.test(ticker)) return 'Bond';
  if (n.includes('бпиф') || n.includes('пай')) return 'ETF';
  return 'Stock';
}

/** Раздел «1.1 Совершённые и исполненные сделки» → RawRow[] */
function parseTradesSection(ws: ExcelJS.Worksheet, from: number, to: number): RawRow[] {
  const out: RawRow[] = [];
  for (let r = from; r <= to; r++) {
    const kind = cellText(ws, r, TRADE_COL.kind);
    if (!TRADE_KINDS.has(kind)) continue; // пустые строки/разделители

    const rawTicker = cellText(ws, r, TRADE_COL.ticker);
    const ticker = normalizeTicker(rawTicker);
    const name = cellText(ws, r, TRADE_COL.name);
    const qty = cellNum(ws, r, TRADE_COL.qty);
    const tradeAmount = cellNum(ws, r, TRADE_COL.tradeAmount);
    // фактическая цена за единицу в деньгах — не «Цена за единицу» (для облигаций это %)
    const price = qty !== 0 ? new Decimal(tradeAmount).div(qty).toString() : '0';
    const fee = new Decimal(cellNum(ws, r, TRADE_COL.brokerFee))
      .plus(cellNum(ws, r, TRADE_COL.exchangeFee))
      .plus(cellNum(ws, r, TRADE_COL.clearingFee))
      .plus(cellNum(ws, r, TRADE_COL.stampDuty))
      .toString();

    const tradeNo = cellText(ws, r, TRADE_COL.tradeNo);
    out.push({
      date: cellText(ws, r, TRADE_COL.date),
      instrumentType: instrumentTypeFromName(name, ticker),
      ticker,
      currency: cellText(ws, r, TRADE_COL.settleCcy) || 'RUB',
      tradeType: kind,
      quantity: qty.toString(),
      price,
      fee,
      note: `Сделка № ${tradeNo}`,
      // номер сделки уникален — критично для дедупа: у одного тикера в один день
      // может быть много сделок с одинаковым количеством/ценой (напр. регулярный
      // автоинвест в денежный фонд), хэш по значениям тогда схлопнул бы их в «дубль»
      brokerRef: tradeNo || undefined,
    });
  }
  return out;
}

interface CorpActionCredit {
  date: string;
  isin: string;
  kind: 'Dividend' | 'Coupon';
  amount: number;
  reference?: string;
}
interface TaxDebit {
  date: string;
  isin: string;
  amount: number;
}

function depositOrWithdrawRow(date: string, tradeType: 'Deposit' | 'Withdraw', amount: number): RawRow {
  return {
    date,
    tradeType,
    currency: 'RUB',
    quantity: '1',
    price: amount.toString(),
    fee: '0',
    note: tradeType === 'Deposit' ? 'Пополнение счета' : 'Списание со счета',
  };
}

/** Раздел «2. Операции с денежными средствами» → RawRow[] (без денежного хвоста сделок) */
function parseCashSection(ws: ExcelJS.Worksheet, from: number, to: number): RawRow[] {
  const out: RawRow[] = [];
  const credits: CorpActionCredit[] = [];
  const taxes: TaxDebit[] = [];

  for (let r = from; r <= to; r++) {
    const op = cellText(ws, r, CASH_COL.operation);
    if (!op) continue;

    const date = cellText(ws, r, CASH_COL.date) || cellText(ws, r, CASH_COL.settleDate);
    const credit = cellNum(ws, r, CASH_COL.credit);
    const debit = cellNum(ws, r, CASH_COL.debit);
    const note = cellText(ws, r, CASH_COL.note);
    const opLower = op.toLowerCase();

    if (op === 'Пополнение счета') {
      out.push(depositOrWithdrawRow(date, 'Deposit', credit));
    } else if (opLower.includes('списание со счета') || opLower.includes('вывод')) {
      out.push(depositOrWithdrawRow(date, 'Withdraw', debit));
    } else if (op === 'Выплата доходов по корпоративным действиям') {
      const isin = note.match(ISIN_RE)?.[1];
      if (isin) {
        const kdType = note.match(KD_TYPE_RE)?.[1]?.toLowerCase() ?? '';
        const reference = note.match(KD_REF_RE)?.[1];
        credits.push({
          date,
          isin,
          kind: kdType.startsWith('куп') ? 'Coupon' : 'Dividend',
          amount: credit,
          reference,
        });
      }
    } else if (op.startsWith('Налог')) {
      const isin = note.match(ISIN_RE)?.[1];
      if (isin) taxes.push({ date, isin, amount: debit });
    }
    // «Покупка/продажа», «Комиссия за сделки», «DFP/RFP» — денежный хвост сделок
    // из раздела 1.1 (комиссии уже учтены в самой сделке) — пропускаем намеренно.
  }

  for (const c of credits) {
    const tax = taxes.find((t) => t.isin === c.isin && t.date === c.date);
    const net = tax ? c.amount - tax.amount : c.amount;
    out.push({
      date: c.date,
      tradeType: c.kind,
      ticker: c.isin, // тикера нет — резолвер попробует instruments.isin
      currency: 'RUB',
      quantity: '1',
      price: net.toString(),
      fee: '0',
      note: `${c.kind === 'Dividend' ? 'Дивиденд' : 'Купон'} нетто (ISIN ${c.isin}${tax ? ', налог учтён' : ''})`,
      brokerRef: c.reference,
    });
  }

  return out;
}

/** Ищет строку заголовка таблицы внутри раздела по совпадению двух ключевых ячеек */
function findHeaderRow(
  ws: ExcelJS.Worksheet,
  from: number,
  to: number,
  col1: number,
  text1: string,
  col2: number,
  text2: string,
): number | null {
  for (let r = from; r <= to; r++) {
    if (cellText(ws, r, col1) === text1 && cellText(ws, r, col2) === text2) return r;
  }
  return null;
}

/** Главная точка входа: лист xlsx-отчёта Т-Банка → RawRow[] */
export function parseTbankXlsx(ws: ExcelJS.Worksheet): RawRow[] {
  const markers = findSectionMarkers(ws);
  const rows: RawRow[] = [];

  const idx11 = markers.findIndex((m) => m.label.startsWith('1.1'));
  if (idx11 !== -1) {
    const from = markers[idx11].row + 2; // маркер раздела + строка заголовков таблицы
    const to = (idx11 + 1 < markers.length ? markers[idx11 + 1].row : ws.rowCount + 1) - 1;
    rows.push(...parseTradesSection(ws, from, to));
  }

  const idx2 = markers.findIndex((m) => m.label.startsWith('2.'));
  if (idx2 !== -1) {
    const sectionTo = (idx2 + 1 < markers.length ? markers[idx2 + 1].row : ws.rowCount + 1) - 1;
    const headerRow = findHeaderRow(ws, markers[idx2].row, sectionTo, CASH_COL.date, 'Дата', CASH_COL.operation, 'Операция');
    if (headerRow) {
      rows.push(...parseCashSection(ws, headerRow + 1, sectionTo));
    }
  }

  return rows;
}
