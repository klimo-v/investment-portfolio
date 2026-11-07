import Decimal from 'decimal.js';
import type { Operation } from './schemas';
import { futuresMultiplier, quikCodeToTicker, scaleByPowerOfTen } from './futures';

/**
 * Аннотации исполнения — необязательное обогащение уже импортированных операций:
 * тег (причина входа/выхода) и сигнальная цена, от которой считается проскальзывание.
 * Это НЕ второй журнал сделок: источник истины по сделкам, ценам и комиссиям — отчёт
 * брокера. Аннотация привязывается к существующей операции по номеру сделки и ничего
 * в ней не меняет (см. mergeBrokerFields: источник 'annotation' не правит операцию).
 */

/** Строка выгрузки исполнения, приведённая к единому виду (цены уже в ₽ за контракт) */
export interface AnnotationRow {
  /** номер строки в файле (с 1, без заголовка) — для сообщений об ошибках */
  line: number;
  /** номер сделки у брокера — ключ сопоставления с операцией (brokerRef) */
  brokerRef: string;
  date: string;
  time: string | null;
  /** тикер отчёта брокера (CNY-12.26), полученный из кода контракта терминала */
  ticker: string;
  side: 'Buy' | 'Sell';
  quantity: string;
  price: string;
  tag: string | null;
  /** сигнальная цена, ₽ за контракт; null — в выгрузке не задана */
  signalPrice: string | null;
}

/** Строка файла, которую не удалось разобрать, — с причиной (не теряем молча) */
export interface AnnotationParseError {
  line: number;
  reason: string;
}

export interface AnnotationParseResult {
  rows: AnnotationRow[];
  errors: AnnotationParseError[];
}

/** Парсер формата выгрузки (Strategy/OCP: новый формат = новый парсер, ядро не меняется) */
export interface AnnotationParser {
  /** идентификатор формата и значение поля `source` у сохранённых аннотаций */
  readonly id: string;
  parse(content: string): AnnotationParseResult;
}

// ───────────────────────────── парсер выгрузки QUIK ─────────────────────────────

const QUIK_REQUIRED = ['date', 'time', 'contract', 'side', 'qty', 'price', 'reason', 'ref_price', 'trade_num'];

/**
 * Выгрузка исполнения терминала QUIK (`yv1_trades.csv`):
 * date,time,contract,side,qty,price,reason,ref_price,slip_rub,slip_pct,
 * broker_fee_quik,exchange_fee,clearing_fee,techcenter_fee,order_num,trade_num.
 *
 * Берём только то, что нужно для аннотаций. Колонки комиссий (`*_fee*`) — оценка
 * терминала, а не факт: факт — в отчёте брокера, поэтому игнорируются. `slip_rub` и
 * `slip_pct` тоже не читаются: проскальзывание считается в ядре (slippageRub), файл
 * годится лишь для сверки в тестах.
 */
export const quikTradesParser: AnnotationParser = {
  id: 'quik-trades',
  parse(content: string): AnnotationParseResult {
    const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
    const rows: AnnotationRow[] = [];
    const errors: AnnotationParseError[] = [];
    if (lines.length === 0) return { rows, errors };

    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const missing = QUIK_REQUIRED.filter((c) => !header.includes(c));
    if (missing.length > 0) {
      return { rows, errors: [{ line: 0, reason: `В файле нет колонок: ${missing.join(', ')}` }] };
    }
    const col = (cells: string[], name: string): string => (cells[header.indexOf(name)] ?? '').trim();

    for (const [i, text] of lines.slice(1).entries()) {
      const line = i + 1;
      const c = text.split(',');
      const fail = (reason: string) => errors.push({ line, reason });

      const contract = col(c, 'contract');
      const ticker = quikCodeToTicker(contract);
      if (!ticker) { fail(`Неизвестный код контракта "${contract}": добавьте серию в FUTURES_SPECS`); continue; }
      const multiplier = futuresMultiplier(ticker);
      if (!multiplier) { fail(`Неизвестная серия контракта "${contract}"`); continue; }

      const date = col(c, 'date');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { fail(`Не удалось разобрать дату "${date}"`); continue; }
      const sideRaw = col(c, 'side').toUpperCase();
      const side = sideRaw === 'B' ? 'Buy' : sideRaw === 'S' ? 'Sell' : null;
      if (!side) { fail(`Неизвестная сторона "${col(c, 'side')}" (ожидается B или S)`); continue; }
      const brokerRef = col(c, 'trade_num');
      if (!brokerRef) { fail('Нет номера сделки (trade_num) — сопоставить не с чем'); continue; }
      const qty = col(c, 'qty');
      const price = col(c, 'price');
      if (!/^\d+(\.\d+)?$/.test(qty)) { fail(`Не удалось разобрать количество "${qty}"`); continue; }
      if (!/^\d+(\.\d+)?$/.test(price)) { fail(`Не удалось разобрать цену "${price}"`); continue; }
      const ref = col(c, 'ref_price');
      if (ref !== '' && !/^\d+(\.\d+)?$/.test(ref)) { fail(`Не удалось разобрать ref_price "${ref}"`); continue; }

      const time = col(c, 'time');
      rows.push({
        line,
        brokerRef,
        date,
        time: /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : null,
        ticker,
        side,
        quantity: qty,
        // цены выгрузки — в котировке (12.421), в журнале — ₽ за контракт (12421):
        // сдвигаем запятую строкой, без float
        price: scaleByPowerOfTen(price, multiplier),
        tag: col(c, 'reason') || null,
        signalPrice: ref === '' ? null : scaleByPowerOfTen(ref, multiplier),
      });
    }
    return { rows, errors };
  },
};

/** Реестр парсеров (Factory Method: формат → парсер) */
export const ANNOTATION_PARSERS: Readonly<Record<string, AnnotationParser>> = {
  [quikTradesParser.id]: quikTradesParser,
};

// ───────────────────────────── сопоставление с операциями ─────────────────────────────

/** Операция журнала вместе с тикером инструмента (в операции только instrumentId) */
export interface MatchableOperation {
  operation: Operation;
  ticker: string | null;
}

export type AnnotationMatch =
  | { ok: true; row: AnnotationRow; operationId: string }
  | { ok: false; row: AnnotationRow; reason: string };

const sameNumber = (a: string, b: string): boolean => new Decimal(a).eq(new Decimal(b));

/**
 * Сопоставляет строки выгрузки с операциями по номеру сделки (brokerRef) — точно, без
 * эвристик по дате и цене. Совпавший номер ещё должен пройти проверку согласованности
 * (инструмент, сторона, количество, цена, дата): иначе строка — ошибка с причиной.
 * Не найденные строки (например, закрывающая позицию, открытую до начала выгрузки, или
 * сделка из отчёта, который ещё не импортирован) возвращаются с причиной, а не теряются.
 */
export function matchAnnotations(
  rows: readonly AnnotationRow[],
  operations: readonly MatchableOperation[],
): AnnotationMatch[] {
  const byRef = new Map<string, MatchableOperation[]>();
  for (const m of operations) {
    const ref = m.operation.brokerRef;
    if (ref) byRef.set(ref, [...(byRef.get(ref) ?? []), m]);
  }

  return rows.map((row): AnnotationMatch => {
    const fail = (reason: string): AnnotationMatch => ({ ok: false, row, reason });
    const candidates = byRef.get(row.brokerRef) ?? [];
    if (candidates.length === 0) {
      return fail(
        `Сделка № ${row.brokerRef} не найдена в журнале — импортируйте отчёт брокера за этот период`,
      );
    }
    const found = candidates.filter((c) => c.ticker === row.ticker);
    if (found.length === 0) {
      return fail(`Сделка № ${row.brokerRef} относится к другому инструменту, а не к ${row.ticker}`);
    }
    if (found.length > 1) return fail(`Номер сделки ${row.brokerRef} не уникален в журнале`);
    const op = found[0].operation;

    if (op.operationType !== row.side) {
      return fail(`Сторона не совпала: в журнале ${op.operationType}, в файле ${row.side}`);
    }
    if (!sameNumber(op.quantity, row.quantity)) {
      return fail(`Количество не совпало: в журнале ${op.quantity}, в файле ${row.quantity}`);
    }
    if (!sameNumber(op.price, row.price)) {
      return fail(`Цена не совпала: в журнале ${op.price}, в файле ${row.price}`);
    }
    if (op.date !== row.date) {
      return fail(`Дата не совпала: в журнале ${op.date}, в файле ${row.date}`);
    }
    if (!op.id) return fail('У операции нет id');
    return { ok: true, row, operationId: op.id };
  });
}

// ───────────────────────────────── проскальзывание ─────────────────────────────────

/**
 * Проскальзывание сделки в рублях: насколько цена исполнения хуже сигнальной, умножено
 * на количество. Положительное — потеряли (купили дороже / продали дешевле сигнала),
 * отрицательное — исполнились лучше сигнала. Цены — ₽ за контракт, множитель серии уже
 * применён при разборе выгрузки.
 *   Buy:  (цена − сигнал) × кол-во;   Sell: (сигнал − цена) × кол-во.
 */
export function slippageRub(
  side: 'Buy' | 'Sell',
  price: Decimal.Value,
  signalPrice: Decimal.Value,
  quantity: Decimal.Value,
): Decimal {
  const diff = new Decimal(price).minus(signalPrice);
  return (side === 'Buy' ? diff : diff.neg()).mul(quantity);
}
