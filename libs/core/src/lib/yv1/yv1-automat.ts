import Decimal from 'decimal.js';
import { parseCsvRecords, QsnapFormatError } from './qsnap';
import type { Side } from './qsnap-extract';

/**
 * Файлы автомата `yv1_trader.lua` (каталог from_quik): журнал сделок, итоги дней,
 * сигналы и логи. Это ВТОРОЙ источник по тем же сделкам QUIK — с причинами входа
 * (h1/h2/exit) и ref_price, но с дырами по комиссиям. Правило принадлежности сделки
 * торговой системе: она есть в этом журнале (счёт + CR* + trade_num).
 */

export interface AutomatTrade {
  tradeNum: string;
  orderNum: string | null;
  date: string;
  /** `HH:MM:SS` (секундная точность) */
  time: string;
  contract: string;
  side: Side;
  qty: string;
  price: string;
  /** exit | h1 | h2 | иное — как записал автомат */
  reason: string;
  refPrice: string | null;
  slipRub: string | null;
  brokerFeeQuik: string | null;
  exchangeFee: string | null;
  clearingFee: string | null;
  techCenterFee: string | null;
  sourceFile: string;
}

function optDec(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  if (v === '') return null;
  try {
    return new Decimal(v.replace(',', '.')).toFixed();
  } catch {
    return null;
  }
}

function headerIndex(records: string[][], required: string[], what: string): Map<string, number> {
  const header = records[0] ?? [];
  const pos = new Map(header.map((h, i) => [h.trim(), i]));
  for (const col of required) {
    if (!pos.has(col)) throw new QsnapFormatError(`${what}: нет колонки «${col}»`);
  }
  return pos;
}

/**
 * Журнал сделок автомата. Встречаются три шапки: `yv1_trades.csv` (с `broker_fee_quik`),
 * `yv1_trades_before_*.csv` (`broker_fee`) и `yv1_fills.csv` (без комиссий и ref_price).
 */
export function parseAutomatTrades(text: string, sourceFile: string): AutomatTrade[] {
  const records = parseCsvRecords(text);
  if (records.length === 0) return [];
  const pos = headerIndex(
    records,
    ['date', 'time', 'contract', 'side', 'qty', 'price', 'reason', 'order_num', 'trade_num'],
    sourceFile,
  );
  const col = (r: string[], name: string): string | undefined => {
    const i = pos.get(name);
    return i === undefined ? undefined : r[i];
  };
  const out: AutomatTrade[] = [];
  for (let i = 1; i < records.length; i++) {
    const r = records[i];
    const side = (col(r, 'side') ?? '').trim();
    if (side !== 'B' && side !== 'S') {
      throw new QsnapFormatError(`${sourceFile}: строка ${i + 1}, сторона «${side}» — ожидалось B или S`);
    }
    out.push({
      tradeNum: (col(r, 'trade_num') ?? '').trim(),
      orderNum: (col(r, 'order_num') ?? '').trim() || null,
      date: (col(r, 'date') ?? '').trim(),
      time: (col(r, 'time') ?? '').trim(),
      contract: (col(r, 'contract') ?? '').trim(),
      side,
      qty: optDec(col(r, 'qty')) ?? '0',
      price: optDec(col(r, 'price')) ?? '0',
      reason: (col(r, 'reason') ?? '').trim(),
      refPrice: optDec(col(r, 'ref_price')),
      slipRub: optDec(col(r, 'slip_rub')),
      brokerFeeQuik: optDec(col(r, 'broker_fee_quik') ?? col(r, 'broker_fee')),
      exchangeFee: optDec(col(r, 'exchange_fee')),
      clearingFee: optDec(col(r, 'clearing_fee')),
      techCenterFee: optDec(col(r, 'techcenter_fee')),
      sourceFile,
    });
  }
  return out;
}

/** Итог дня из `yv1_daily.csv`; вариационная маржа за день — снимок ДО клиринга, не итог */
export interface AutomatDay {
  date: string;
  positionsOvernight: string | null;
  /** рубли Т0 утром этого дня и утром следующего торгового дня */
  t0Start: string | null;
  t0Next: string | null;
  cashChange: string | null;
  vm: string | null;
  vmReal: string | null;
  vmTotal: string | null;
  feeBrokerQuik: string | null;
  feeExchange: string | null;
}

export function parseAutomatDaily(text: string): AutomatDay[] {
  const records = parseCsvRecords(text);
  if (records.length === 0) return [];
  const pos = headerIndex(records, ['date'], 'yv1_daily.csv');
  const col = (r: string[], name: string): string | undefined => {
    const i = pos.get(name);
    return i === undefined ? undefined : r[i];
  };
  return records.slice(1).map((r) => ({
    date: (col(r, 'date') ?? '').trim(),
    positionsOvernight: optDec(col(r, 'positions_overnight')),
    t0Start: optDec(col(r, 't0_start')),
    t0Next: optDec(col(r, 't0_next')),
    cashChange: optDec(col(r, 'cash_change')),
    vm: optDec(col(r, 'vm')),
    vmReal: optDec(col(r, 'vm_real')),
    vmTotal: optDec(col(r, 'vm_total')),
    feeBrokerQuik: optDec(col(r, 'fee_broker_quik')),
    feeExchange: optDec(col(r, 'fee_exchange')),
  }));
}

/** Строка `yv1_signals.csv`: решения дня по половинам и сколько реально исполнено */
export interface AutomatSignal {
  date: string;
  contract: string;
  preGap: boolean;
  p0: string | null;
  h1: HalfSignal;
  h2: HalfSignal;
  dryRun: boolean;
}

export interface HalfSignal {
  px: string | null;
  rel: string | null;
  /** сигнал: 1 лонг, −1 шорт, 0 нет входа */
  signal: number;
  /** запланированный размер, контрактов */
  planned: number;
  /** исполнено со знаком (−65 для шорта на 65); null — поле пустое */
  filled: number | null;
  skip: string;
}

function half(get: (n: string) => string | undefined, p: 'h1' | 'h2'): HalfSignal {
  const num = (n: string): number => Number((get(`${p}_${n}`) ?? '').trim() || '0');
  const filledRaw = (get(`${p}_filled`) ?? '').trim();
  return {
    px: optDec(get(`${p}_px`)),
    rel: optDec(get(`${p}_rel`)),
    signal: num('s'),
    planned: num('n'),
    filled: filledRaw === '' ? null : Number(filledRaw),
    skip: (get(`${p}_skip`) ?? '').trim(),
  };
}

export function parseAutomatSignals(text: string): AutomatSignal[] {
  const records = parseCsvRecords(text);
  if (records.length === 0) return [];
  const pos = headerIndex(records, ['date', 'contract', 'h1_s', 'h2_s'], 'yv1_signals.csv');
  return records.slice(1).map((r) => {
    const get = (n: string): string | undefined => {
      const i = pos.get(n);
      return i === undefined ? undefined : r[i];
    };
    return {
      date: (get('date') ?? '').trim(),
      contract: (get('contract') ?? '').trim(),
      preGap: (get('pre_gap') ?? '').trim() === '1',
      p0: optDec(get('p0')),
      h1: half(get, 'h1'),
      h2: half(get, 'h2'),
      dryRun: (get('dry_run') ?? '').trim() === 'true',
    };
  });
}

/** Параметры размера, с которыми автомат стартовал в этот день (строка «старт:» лога) */
export interface SizingDay {
  date: string;
  dryRun: boolean;
  /** контрактов на половину при фиксированном размере; null — размер от капитала */
  halfQty: number | null;
  /** капитал для размера, ₽; null при фиксированном размере */
  capital: string | null;
  leverage: string;
  maxGross: number;
}

export interface AutomatLogDay {
  date: string;
  /** последняя строка «старт:» за день (перезапуски в течение дня берём последний) */
  sizing: SizingDay | null;
  /** строки лога про остановку торговли (halt) */
  haltLines: string[];
}

const START_RE =
  /старт:\s*DRY_RUN=(\w+),\s*на половину\s+(?:от капитала\s+(\d+)|(\d+)\s*шт),\s*плечо\s+([\d.]+),\s*потолок\s+(\d+)/;

/** Лог автомата за один день; дату берём из имени файла `yv1_log_YYYY-MM-DD.txt` */
export function parseAutomatLog(text: string, date: string): AutomatLogDay {
  let sizing: SizingDay | null = null;
  const haltLines: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(START_RE);
    if (m) {
      sizing = {
        date,
        dryRun: m[1] === 'true',
        halfQty: m[3] !== undefined ? Number(m[3]) : null,
        capital: m[2] ?? null,
        leverage: m[4],
        maxGross: Number(m[5]),
      };
    }
    if (/\bhalt\b/i.test(line) && !/halt\s*=\s*0/i.test(line)) haltLines.push(line.trim());
  }
  return { date, sizing, haltLines };
}
