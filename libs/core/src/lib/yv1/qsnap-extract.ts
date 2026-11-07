import Decimal from 'decimal.js';
import { QsnapFormatError, type SnapshotTables, type TableRow } from './qsnap';

/**
 * Извлечение сделок, остатков и параметров из таблиц ОДНОГО снимка моста.
 * Деньги и количества остаются десятичными строками (CLAUDE.md §11).
 */

export type Side = 'B' | 'S';

export interface QsnapTrade {
  tradeNum: string;
  orderNum: string | null;
  /** торговый счёт сделки — внутренний ключ, наружу (API/UI) не отдаём */
  account: string;
  classCode: string;
  /** код бумаги (sec_code), напр. CRZ6 */
  secCode: string;
  /** биржевое время (МСК): `YYYY-MM-DD` */
  date: string;
  /** `HH:MM:SS` */
  time: string;
  /** миллисекунды, 3 знака */
  ms: string;
  qty: string;
  price: string;
  value: string;
  /** «комиссия брокера» QUIK — завышенная оценка, а не списание */
  brokerFeeQuik: string;
  exchangeFee: string;
  clearingFee: string;
  techCenterFee: string;
  flags: number;
  /** направление по флагам заявки; null, если заявки сделки нет в снимке */
  side: Side | null;
}

function dec(raw: string | undefined, where: string): string {
  const v = (raw ?? '').trim();
  if (v === '') return '0';
  try {
    return new Decimal(v.replace(',', '.')).toFixed();
  } catch {
    throw new QsnapFormatError(`${where}: «${raw}» не число`);
  }
}

function need(row: TableRow, field: string, where: string): string {
  const v = row[field];
  if (v === undefined) throw new QsnapFormatError(`${where}: нет поля «${field}» — формат таблицы изменился`);
  return v;
}

const pad = (v: string, n: number): string => v.padStart(n, '0');

/**
 * Направление заявки по флагам QLua: бит 2 (0x4) — заявка на продажу. Проверено только
 * на покупках (в имеющихся снимках продаж нет), поэтому при сверке с журналом автомата
 * расхождение по стороне подсвечивается отдельным пунктом.
 */
export function sideFromOrderFlags(flags: number): Side {
  return (flags & 0x4) !== 0 ? 'S' : 'B';
}

export function extractTrades(tables: SnapshotTables): QsnapTrade[] {
  const orders = new Map<string, number>();
  for (const o of tables.get('orders') ?? []) {
    const num = o['order_num'] ?? o['ordernum'];
    const flags = Number(o['flags']);
    if (num && Number.isFinite(flags)) orders.set(num, flags);
  }

  const out: QsnapTrade[] = [];
  (tables.get('trades') ?? []).forEach((t, i) => {
    const where = `trades[${i}]`;
    const tradeNum = need(t, 'trade_num', where);
    const year = need(t, 'datetime.year', where);
    const orderNum = t['order_num'] || t['ordernum'] || null;
    const flags = Number(t['flags'] ?? '0');
    const orderFlags = orderNum ? orders.get(orderNum) : undefined;
    out.push({
      tradeNum,
      orderNum,
      account: t['account'] ?? '',
      classCode: t['class_code'] ?? '',
      secCode: need(t, 'sec_code', where),
      date: `${year}-${pad(need(t, 'datetime.month', where), 2)}-${pad(need(t, 'datetime.day', where), 2)}`,
      time: `${pad(need(t, 'datetime.hour', where), 2)}:${pad(need(t, 'datetime.min', where), 2)}:${pad(
        need(t, 'datetime.sec', where) || '0',
        2,
      )}`,
      ms: pad(t['datetime.ms'] ?? '0', 3),
      qty: dec(need(t, 'qty', where), `${where}.qty`),
      price: dec(need(t, 'price', where), `${where}.price`),
      value: dec(need(t, 'value', where), `${where}.value`),
      brokerFeeQuik: dec(t['broker_comission'], `${where}.broker_comission`),
      exchangeFee: dec(t['exchange_comission'], `${where}.exchange_comission`),
      clearingFee: dec(t['clearing_comission'], `${where}.clearing_comission`),
      techCenterFee: dec(t['tech_center_comission'], `${where}.tech_center_comission`),
      flags: Number.isFinite(flags) ? flags : 0,
      side: orderFlags === undefined ? null : sideFromOrderFlags(orderFlags),
    });
  });
  return out;
}

/** Расчётная комиссия скрипта (таблица `calc_trades`, версия скрипта 3) */
export interface QsnapCalcTrade {
  tradeNum: string;
  secCode: string;
  value: string;
  rate: string;
  brokerFee: string;
  brokerFeeExact: string;
  tsFee: string;
  totalFee: string;
  quikBrokerComission: string;
}

export function extractCalcTrades(tables: SnapshotTables): QsnapCalcTrade[] {
  return (tables.get('calc_trades') ?? []).map((r, i) => {
    const where = `calc_trades[${i}]`;
    return {
      tradeNum: need(r, 'trade_num', where),
      secCode: r['sec_code'] ?? '',
      value: dec(r['value'], `${where}.value`),
      rate: dec(r['rate'], `${where}.rate`),
      brokerFee: dec(r['broker_fee'], `${where}.broker_fee`),
      brokerFeeExact: dec(r['broker_fee_exact'], `${where}.broker_fee_exact`),
      tsFee: dec(r['ts_fee'], `${where}.ts_fee`),
      totalFee: dec(r['total_fee'], `${where}.total_fee`),
      quikBrokerComission: dec(r['quik_broker_comission'], `${where}.quik_broker_comission`),
    };
  });
}

export interface QsnapHolding {
  account: string;
  secCode: string;
  startNet: string;
  totalNet: string;
  /** ВМ за день; пока клиринг не прошёл — индикативная */
  varMargin: string;
  /** «реальная» ВМ: ненулевая, когда ВМ уже проведена клирингом */
  realVarMargin: string;
  totalVarMargin: string;
}

export interface QsnapMoney {
  /** рубли Т0: на начало дня и сейчас */
  t0Open: string;
  t0Current: string;
  t1Open: string;
  t1Current: string;
  t365Open: string;
  t365Current: string;
  /** несколько клиентских кодов с ненулевым Т0 — выбран первый, значение сомнительно */
  ambiguous: boolean;
}

export interface QsnapAccountState {
  holdings: QsnapHolding[];
  /** ВМ по строкам futures_client_limits (по счетам) */
  limitsVarMargin: { account: string; varMargin: string }[];
  money: QsnapMoney | null;
  /** `CLASS:SEC:PARAM` → значение, напр. `SPBFUT:CRZ6:SETTLEPRICE` */
  params: Record<string, string>;
}

export function extractAccountState(tables: SnapshotTables): QsnapAccountState {
  const holdings: QsnapHolding[] = (tables.get('futures_client_holding') ?? []).map((h, i) => {
    const where = `futures_client_holding[${i}]`;
    return {
      account: h['trdaccid'] ?? '',
      secCode: h['sec_code'] ?? h['seccode'] ?? '',
      startNet: dec(h['startnet'], `${where}.startnet`),
      totalNet: dec(h['totalnet'], `${where}.totalnet`),
      varMargin: dec(h['varmargin'], `${where}.varmargin`),
      realVarMargin: dec(h['real_varmargin'], `${where}.real_varmargin`),
      totalVarMargin: dec(h['total_varmargin'], `${where}.total_varmargin`),
    };
  });

  const limitsVarMargin = (tables.get('futures_client_limits') ?? []).map((l, i) => ({
    account: l['trdaccid'] ?? '',
    varMargin: dec(l['varmargin'], `futures_client_limits[${i}].varmargin`),
  }));

  // money_limits: по строке на (клиентский код × вид лимита). Рубли — валюта SUR.
  const byClient = new Map<string, Map<string, TableRow>>();
  for (const m of tables.get('money_limits') ?? []) {
    if ((m['currcode'] ?? 'SUR') !== 'SUR') continue;
    const client = m['client_code'] ?? '';
    let kinds = byClient.get(client);
    if (!kinds) byClient.set(client, (kinds = new Map()));
    kinds.set(m['limit_kind'] ?? '', m);
  }
  const candidates = [...byClient.values()].filter((k) => k.has('0'));
  let money: QsnapMoney | null = null;
  if (candidates.length > 0) {
    const kinds = candidates[0];
    const cur = (kind: string, f: 'currentbal' | 'openbal'): string => dec(kinds.get(kind)?.[f], `money_limits[${kind}].${f}`);
    money = {
      t0Open: cur('0', 'openbal'),
      t0Current: cur('0', 'currentbal'),
      t1Open: cur('1', 'openbal'),
      t1Current: cur('1', 'currentbal'),
      t365Open: cur('365', 'openbal'),
      t365Current: cur('365', 'currentbal'),
      ambiguous: candidates.length > 1,
    };
  }

  const params: Record<string, string> = {};
  for (const [name, rows] of tables) {
    if (!name.startsWith('param:')) continue;
    const row = rows[0];
    if (!row || row['result'] === '0') continue;
    const v = row['param_value'];
    if (v !== undefined && v !== '') params[name.slice('param:'.length)] = dec(v, name);
  }

  return { holdings, limitsVarMargin, money, params };
}
