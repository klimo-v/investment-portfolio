import type { RawRow } from '../import';

/**
 * Парсер HTML-отчёта брокера (формат «Отчет брокера», торговый код в шапке —
 * напр. SESPS) в RawRow[] — тот же контракт, что и `parseCsv` (Strategy/LSP,
 * CLAUDE.md §7). Дальше строки идут в общий движок классификации/дедупа (DRY).
 *
 * Осознанные решения (docs/02-data-model.md §6, docs/04-roadmap.md §3.1):
 *  - Источник сделок Buy/Sell — таблица «Сделки купли/продажи ЦБ», НЕ «Движение
 *    денежных средств» (там те же сделки денежным хвостом → двойной счёт).
 *  - Комиссии берём из колонок сделки (Брокера + Биржи), а не из строк «Комиссия…».
 *  - Из «Движения ДС» берём только то, чего нет в сделках: дивиденды, купоны,
 *    зачисления/списания денег.
 *  - Валютные/товарные сделки (GLD/RUB) — отдельная таблица с другими колонками.
 *  - `system` в отчёте отсутствует всегда — это разметка пользователя (§3.1),
 *    назначается на весь батч в UI импорта, здесь не заполняется.
 *  - `accountRef`/`accountKind` — признак СЧЁТА (не системы!): один файл в общем
 *    случае может описывать несколько счетов одного брокера (обычный ↔ ИИС),
 *    поэтому документ обходится последовательно (а не «все таблицы одним мешком»),
 *    и каждая строка помечается счётом, действовавшим на момент встречи её таблицы.
 */

// --- Низкоуровневое извлечение (без внешних зависимостей, YAGNI §11) ---

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Текст ячейки/фрагмента: снять теги, декодировать сущности, схлопнуть пробелы */
function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/[\s ]+/g, ' ')
    .trim();
}

type Segment = { kind: 'table'; rows: string[][] } | { kind: 'text'; text: string };

/**
 * Документ как последовательность сегментов «таблица» / «текст между таблицами»,
 * в порядке появления. Порядок нужен, чтобы понимать, какой счёт (accountRef)
 * действовал в момент конкретной таблицы — маркеры счёта лежат в тексте (§3.1).
 */
function segmentDocument(html: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const m of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const start = m.index ?? 0;
    if (start > last) segments.push({ kind: 'text', text: html.slice(last, start) });

    const rows: string[][] = [];
    for (const rm of m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...rm[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => plainText(c[1]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) segments.push({ kind: 'table', rows });

    last = start + m[0].length;
  }
  if (last < html.length) segments.push({ kind: 'text', text: html.slice(last) });
  return segments;
}

/** Убрать разделители разрядов, привести запятую к точке (строкой, без потери точности) */
function clean(raw: string | undefined): string {
  return (raw ?? '').replace(/[\s ]/g, '').replace(',', '.');
}

/** Число из ячейки (для суммирования комиссий) */
function num(raw: string | undefined): number {
  const n = Number(clean(raw));
  return Number.isFinite(n) ? n : 0;
}

/** Сумма двух комиссий (брокер+биржа) как десятичная строка с округлением до копеек */
function feeSum(a: string | undefined, b: string | undefined): string {
  return (Math.round((num(a) + num(b)) * 100) / 100).toString();
}

const DATE_RE = /^\d{2}\.\d{2}\.\d{4}$/;
const ISIN_RE = /^RU[0-9A-Z]{10}$/;
const BUY_SELL = new Set(['Покупка', 'Продажа']);

/** Тип инструмента из графы «Вид, Категория» Справочника ЦБ */
function instrumentTypeFromRef(kind: string): string {
  const k = kind.toLowerCase();
  if (k.includes('облигаци')) return 'Bond';
  if (k.includes('фонд') || k.includes('пай')) return 'ETF';
  if (k.includes('расписк')) return 'Stock';
  if (k.includes('акци')) return 'Stock';
  return 'Stock';
}

interface Reference {
  /** имя ЦБ → тикер (для резолва дивидендов, где нет кода) */
  nameToTicker: Map<string, string>;
  /** тикер → тип инструмента */
  tickerToType: Map<string, string>;
}

/** Собрать справочник ЦБ (имя→код→тип) из таблицы «Справочник Ценных Бумаг» */
function buildReference(tables: string[][][]): Reference {
  const nameToTicker = new Map<string, string>();
  const tickerToType = new Map<string, string>();
  for (const table of tables) {
    for (const cells of table) {
      // строка справочника: name | code | ISIN | эмитент | вид,категория | выпуск
      if (cells.length >= 5 && ISIN_RE.test(cells[2]) && /^[A-Z0-9]{1,12}$/.test(cells[1])) {
        const name = cells[0];
        const ticker = cells[1];
        nameToTicker.set(name, ticker);
        tickerToType.set(ticker, instrumentTypeFromRef(cells[4]));
      }
    }
  }
  return { nameToTicker, tickerToType };
}

/** Найти тикер по вхождению названия ЦБ в описание операции (для дивидендов/купонов) */
function resolveTickerFromDescription(desc: string, ref: Reference): string | undefined {
  for (const [name, ticker] of ref.nameToTicker) {
    if (name && desc.includes(name)) return ticker;
  }
  return undefined;
}

// --- Признак счёта (accountRef/accountKind) из текста между таблицами (§3.1) ---

/** Счёт, действующий в текущей точке документа (обновляется по маркерам в тексте) */
interface AccountContext {
  accountRef?: string;
  accountKind?: 'IIS' | 'Brokerage';
}

/**
 * Разбирает маркеры счёта в произвольном текстовом фрагменте отчёта:
 *  - «Договор на ведение индивидуального инвестиционного счета SESPS…» → ИИС.
 *  - «Договор на брокерское обслуживание …» → обычный брокерский счёт.
 *  - «Торговый код: SESPS» — код счёта (может стоять отдельно от договора).
 * Оба вида договора эвристически ищут код счёта (заглавные буквы/цифры) рядом
 * со словом «счёт»/«обслуживание» — это лучшее приближение без второго реального
 * образца отчёта с обычным брокерским счётом; keyword-детект (case-insensitive)
 * и извлечение кода (строго по регистру) разделены, чтобы избежать ложных
 * совпадений на русских словах при `i`-флаге.
 */
function detectAccountUpdates(text: string): Partial<AccountContext> {
  const plain = plainText(text);
  const lower = plain.toLowerCase();
  const updates: Partial<AccountContext> = {};

  if (/торговый\s+код/i.test(plain)) {
    const code = plain.match(/код:?\s*([A-ZА-Я0-9_-]{2,12})/)?.[1];
    if (code) updates.accountRef = code;
  }

  if (lower.includes('индивидуальн') && lower.includes('инвестиционн') && lower.includes('счет')) {
    updates.accountKind = 'IIS';
    const code = plain.match(/счет\S*\s+([A-ZА-Я0-9]{3,12})\b/)?.[1];
    if (code) updates.accountRef = code;
  } else if (lower.includes('брокерск') && (lower.includes('обслужив') || lower.includes('счет'))) {
    updates.accountKind = 'Brokerage';
    const code = plain.match(/(?:№|N|счет\S*)\s*([A-ZА-Я0-9]{3,12})\b/)?.[1];
    if (code) updates.accountRef = code;
  }

  return updates;
}

// --- Разбор отдельных таблиц (по форме строки) в RawRow[], с текущим счётом ---

/** Сделки купли/продажи ЦБ (16 колонок; Вид на индексе 6) */
function securityTradeRows(rows: string[][], ref: Reference, ctx: AccountContext): RawRow[] {
  const out: RawRow[] = [];
  for (const c of rows) {
    if (c.length >= 16 && BUY_SELL.has(c[6])) {
      const ticker = c[4];
      out.push({
        date: c[0],
        instrumentType: ref.tickerToType.get(ticker),
        ticker,
        currency: c[5],
        tradeType: c[6],
        quantity: clean(c[7]),
        price: clean(c[8]),
        fee: feeSum(c[11], c[12]),
        note: c[13] ? `Сделка № ${c[13]}` : undefined,
        // номер сделки уникален — критично для дедупа (docs/02-data-model.md §6):
        // без него две сделки с одинаковыми date+тикер+кол-во+цена схлопнутся в «дубль»
        brokerRef: c[13] || undefined,
        accountRef: ctx.accountRef,
        accountKind: ctx.accountKind,
      });
    }
  }
  return out;
}

/** Сделки с валютными/товарными инструментами (GLD/RUB) (12 колонок; Вид на индексе 4) */
function currencyTradeRows(rows: string[][], ctx: AccountContext): RawRow[] {
  const out: RawRow[] = [];
  for (const c of rows) {
    // строка не должна быть сделкой ЦБ (у той Вид на индексе 6)
    if (c.length >= 12 && c.length < 16 && BUY_SELL.has(c[4]) && /^[A-Z]{3}RUB/.test(c[0])) {
      const base = c[0].split('RUB')[0]; // GLDRUB_TOM → GLD
      out.push({
        date: c[1],
        instrumentType: 'Currency',
        ticker: base,
        currency: 'RUB',
        tradeType: c[4],
        quantity: clean(c[5]),
        price: clean(c[6]),
        fee: feeSum(c[8], c[9]),
        note: c[10] ? `Сделка № ${c[10]}` : undefined,
        brokerRef: c[10] || undefined,
        accountRef: ctx.accountRef,
        accountKind: ctx.accountKind,
      });
    }
  }
  return out;
}

/**
 * Движение денежных средств → RawRow[] только для того, чего нет в сделках:
 * дивиденды, купоны, зачисления/списания денег. Сделки и комиссии пропускаем.
 * Колонки: Дата | Площадка | Описание | Валюта | Зачисление | Списание.
 */
function cashFlowRows(rows: string[][], ref: Reference, ctx: AccountContext): RawRow[] {
  const out: RawRow[] = [];
  for (const c of rows) {
    if (c.length !== 6 || !DATE_RE.test(c[0])) continue;
    const date = c[0];
    const desc = c[2];
    const currency = c[3];
    const credit = clean(c[4]); // сумма зачисления
    const debit = clean(c[5]); // сумма списания
    const d = desc.toLowerCase();

    if (d.includes('дивиденд')) {
      out.push(cashRow(date, 'Dividend', credit, currency, desc, ctx, resolveTickerFromDescription(desc, ref)));
    } else if (d.includes('купон')) {
      out.push(cashRow(date, 'Coupon', credit, currency, desc, ctx, resolveTickerFromDescription(desc, ref)));
    } else if (d.includes('зачисление д')) {
      out.push(cashRow(date, 'Deposit', credit, currency, desc, ctx));
    } else if (d.includes('списание д') || d.includes('вывод')) {
      out.push(cashRow(date, 'Withdraw', debit, currency, desc, ctx));
    }
    // «Сделка от…», «Комиссия…» и прочее — намеренно пропускаем (нет двойного счёта)
  }
  return out;
}

function cashRow(
  date: string,
  tradeType: string,
  amount: string,
  currency: string,
  note: string,
  ctx: AccountContext,
  ticker?: string,
): RawRow {
  return {
    date,
    tradeType,
    ticker,
    currency,
    quantity: '1',
    price: amount,
    fee: '0',
    note,
    accountRef: ctx.accountRef,
    accountKind: ctx.accountKind,
  };
}

/** Главная точка входа: HTML-отчёт → RawRow[] (контракт как у parseCsv) */
export function parseBrokerHtmlReport(html: string): RawRow[] {
  const segments = segmentDocument(html);
  const tables = segments.flatMap((s) => (s.kind === 'table' ? [s.rows] : []));
  const ref = buildReference(tables);

  const out: RawRow[] = [];
  let ctx: AccountContext = {};
  for (const seg of segments) {
    if (seg.kind === 'text') {
      ctx = { ...ctx, ...detectAccountUpdates(seg.text) };
      continue;
    }
    out.push(...securityTradeRows(seg.rows, ref, ctx));
    out.push(...currencyTradeRows(seg.rows, ctx));
    out.push(...cashFlowRows(seg.rows, ref, ctx));
  }
  return out;
}
