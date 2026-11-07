import { describe, expect, it } from 'vitest';
import {
  assessSnapshots,
  parseQsnapIndex,
  type SnapshotTables,
  type TableRow,
} from './qsnap';
import { extractAccountState, extractCalcTrades, extractTrades } from './qsnap-extract';
import { parseAutomatDaily, parseAutomatLog, parseAutomatSignals, parseAutomatTrades } from './yv1-automat';
import {
  checkCalcTrades,
  checkCoverage,
  checkSignals,
  checkSnapshotPosition,
  moneyIdentity,
} from './yv1-checks';
import { buildCycles, compareFeeRounding, debtInterest, modelBrokerFee } from './yv1-cycles';
import { buildFills, type SnapshotTrade, type Yv1Fill } from './yv1-fills';
import { buildYv1Overview, curveToCsv, scaleCurve } from './yv1-report';

/**
 * Числа — реальные (цикл 05→06.11.2026), идентификаторы счёта/клиента заменены на
 * ACC1/CL1/CL2. Сверка с отчётом Сбера за 26–30.10: брокер 14.78, биржа 4.52.
 */

/* ------------------------------------------------------------------ фикстуры */

const AUTOMAT_TRADES_CSV = `date,time,contract,side,qty,price,reason,ref_price,slip_rub,slip_pct,broker_fee_quik,exchange_fee,clearing_fee,techcenter_fee,order_num,trade_num
2026-11-05,13:00:04,CRZ6,S,64,12.421,h1,12.422,64.00,0.0081,314.71,21.12,15.36,0.00,2022430710197636722,2022430710194950984
2026-11-05,15:00:03,CRZ6,S,52,12.42,h2,12.42,0.00,0.0000,255.69,17.16,12.48,0.00,2022430710198487455,2022430710195027611
2026-11-05,15:00:03,CRZ6,S,12,12.42,h2,12.42,0.00,0.0000,59.00,3.96,2.88,0.00,2022430710198487455,2022430710195027612
2026-11-06,10:20:00,CRZ6,B,5,12.405,exit,,,,24.56,1.65,1.20,0.00,2022430714490673335,2022430714489774749
2026-11-06,10:20:00,CRZ6,B,100,12.405,exit,,,,491.18,33.00,24.00,0.00,2022430714490673335,2022430714489774750
2026-11-06,10:20:00,CRZ6,B,23,12.405,exit,,,,112.97,7.59,5.52,0.00,2022430714490673335,2022430714489774751
`;

function row(o: Record<string, string>): TableRow {
  return o;
}

function tradeRow(o: {
  num: string;
  order: string;
  sec: string;
  cls: string;
  time: [string, string, string, string];
  qty: string;
  price: string;
  value: string;
  brk: string;
  exch: string;
  clr: string;
}): TableRow {
  return row({
    trade_num: o.num,
    order_num: o.order,
    account: 'ACC1',
    class_code: o.cls,
    sec_code: o.sec,
    'datetime.year': '2026',
    'datetime.month': '11',
    'datetime.day': '6',
    'datetime.hour': o.time[0],
    'datetime.min': o.time[1],
    'datetime.sec': o.time[2],
    'datetime.ms': o.time[3],
    qty: o.qty,
    price: o.price,
    value: o.value,
    broker_comission: o.brk,
    exchange_comission: o.exch,
    clearing_comission: o.clr,
    tech_center_comission: '0',
    flags: '64',
  });
}

/** Снимок 20261107_022914: три сделки выхода CRZ6 + покупка SBMM, позиция −128 → 0 */
function snapshotTables(): SnapshotTables {
  const t = new Map<string, TableRow[]>();
  t.set('trades', [
    tradeRow({ num: '2022430714489774749', order: 'O1', sec: 'CRZ6', cls: 'SPBFUT', time: ['10', '20', '0', '939'], qty: '5', price: '12.405', value: '62025', brk: '24.56', exch: '1.65', clr: '1.2' }),
    tradeRow({ num: '2022430714489774750', order: 'O1', sec: 'CRZ6', cls: 'SPBFUT', time: ['10', '20', '0', '939'], qty: '100', price: '12.405', value: '1240500', brk: '491.18', exch: '33', clr: '24' }),
    tradeRow({ num: '2022430714489774751', order: 'O1', sec: 'CRZ6', cls: 'SPBFUT', time: ['10', '20', '0', '939'], qty: '23', price: '12.405', value: '285315', brk: '112.97', exch: '7.59', clr: '5.52' }),
    tradeRow({ num: '18054038222', order: 'O2', sec: 'SBMM', cls: 'TQBR', time: ['10', '28', '43', '66'], qty: '68', price: '19.8', value: '1346.4', brk: '0.27', exch: '0.1', clr: '0.17' }),
  ]);
  t.set('orders', [row({ order_num: 'O1', flags: '24' }), row({ order_num: 'O2', flags: '16' })]);
  t.set('futures_client_holding', [
    row({ trdaccid: 'ACC1', sec_code: 'CRZ6', startnet: '-128', totalnet: '0', varmargin: '-2304', real_varmargin: '0', total_varmargin: '0' }),
  ]);
  t.set('futures_client_limits', [row({ trdaccid: 'ACC1', varmargin: '-2304' })]);
  t.set('money_limits', [
    row({ client_code: 'CL2', currcode: 'SUR', limit_kind: '365', openbal: '0', currentbal: '0' }),
    row({ client_code: 'CL1', currcode: 'SUR', limit_kind: '0', openbal: '4297.96', currentbal: '4297.96' }),
    row({ client_code: 'CL1', currcode: 'SUR', limit_kind: '1', openbal: '4297.96', currentbal: '2322.58' }),
    row({ client_code: 'CL1', currcode: 'SUR', limit_kind: '365', openbal: '4297.96', currentbal: '2322.58' }),
  ]);
  t.set('calc_trades', [
    row({ trade_num: '2022430714489774749', sec_code: 'CRZ6', value: '62025', rate: '0.000150', broker_fee: '9.30', broker_fee_exact: '9.303750', ts_fee: '2.85', total_fee: '12.15', quik_broker_comission: '24.56' }),
    row({ trade_num: '2022430714489774750', sec_code: 'CRZ6', value: '1240500', rate: '0.000150', broker_fee: '186.08', broker_fee_exact: '186.075000', ts_fee: '57.00', total_fee: '243.08', quik_broker_comission: '491.18' }),
    row({ trade_num: '2022430714489774751', sec_code: 'CRZ6', value: '285315', rate: '0.000150', broker_fee: '42.80', broker_fee_exact: '42.797250', ts_fee: '13.11', total_fee: '55.91', quik_broker_comission: '112.97' }),
    row({ trade_num: '18054038222', sec_code: 'SBMM', value: '1346.4', rate: '0.000000', broker_fee: '0.00', broker_fee_exact: '0.000000', ts_fee: '0.27', total_fee: '0.27', quik_broker_comission: '0.27' }),
  ]);
  t.set('param:SPBFUT:CRZ6:LAST', [row({ param_value: '12.443000', result: '1' })]);
  t.set('param:SPBFUT:CRZ6:SETTLEPRICE', [row({ param_value: '12.442000', result: '1' })]);
  return t;
}

const INDEX_TEXT =
  'snap_id,local_time,server_time,server_time_end,trade_date,connected,quik_version,script_version,status,raw_lines,raw_bytes,float_ids,counts,errors\n' +
  '20261107_022914,2026-11-07 02:29:14,1:58:54,1:58:54,06.11.2026,1,12.8.4.9,3,ok,10,100,0,,\n';

function assessment() {
  return assessSnapshots(parseQsnapIndex(INDEX_TEXT), new Map([['20261107_022914', 10]]));
}

/* ------------------------------------------------------------------ извлечение */

describe('извлечение из таблиц снимка', () => {
  const trades = extractTrades(snapshotTables());

  it('время сделки — биржевое МСК как есть, миллисекунды 3 знака', () => {
    expect(trades[0]).toMatchObject({ date: '2026-11-06', time: '10:20:00', ms: '939', tradeNum: '2022430714489774749' });
    expect(trades[3]).toMatchObject({ time: '10:28:43', ms: '066' });
  });

  it('направление — по флагам заявки (24 → покупка)', () => {
    expect(trades.map((t) => t.side)).toEqual(['B', 'B', 'B', 'B']);
  });

  it('нет нужного поля — понятная ошибка формата, а не NaN в расчётах', () => {
    const broken = snapshotTables();
    broken.set('trades', [row({ trade_num: '1' })]);
    expect(() => extractTrades(broken)).toThrow(/datetime\.year/);
  });

  it('деньги: выбран клиентский код, у которого есть лимит Т0', () => {
    const state = extractAccountState(snapshotTables());
    expect(state.money).toMatchObject({ t1Open: '4297.96', t1Current: '2322.58', ambiguous: false });
    expect(state.params['SPBFUT:CRZ6:SETTLEPRICE']).toBe('12.442');
    expect(state.holdings[0]).toMatchObject({ startNet: '-128', totalNet: '0', varMargin: '-2304' });
  });
});

/* ------------------------------------------------------------------ комиссии */

describe('модель комиссии', () => {
  it('эталон отчёта Сбера 26–30.10: округление вверх даёт 14.78, обычное — 14.77', () => {
    const r = compareFeeRounding(['24540', '24568', '49312']);
    expect(r).toEqual({ ceil: '14.78', halfUp: '14.77' });
  });

  it('по сделке: 62 025 ₽ → 9.31 вверх / 9.30 обычное', () => {
    expect(modelBrokerFee('62025', 'ceil')).toBe('9.31');
    expect(modelBrokerFee('62025', 'half-up')).toBe('9.30');
  });

  it('calc_trades сходится с моделью в пределах копейки, биржа и оценка QUIK — точно', () => {
    const res = checkCalcTrades(extractCalcTrades(snapshotTables()), extractTrades(snapshotTables()));
    expect(res.rows).toBe(4);
    expect(res.maxBrokerDiff).toBe('0.01');
    expect(res.discrepancies).toEqual([]);
  });
});

/* ------------------------------------------------------------------ принадлежность и сверка */

describe('сделки: мост + журнал автомата', () => {
  const automat = parseAutomatTrades(AUTOMAT_TRADES_CSV, 'yv1_trades.csv');
  const qsnapTrades: SnapshotTrade[] = extractTrades(snapshotTables()).map((t) => ({ ...t, snapId: '20261107_022914' }));

  it('сделки из журнала автомата — ТС; фонд (не CR*) в список ТС не попадает', () => {
    const { fills, otherTrades, discrepancies } = buildFills({
      qsnapTrades,
      automatTrades: automat,
      verifiableDates: new Set(['2026-11-06']),
    });
    expect(fills).toHaveLength(6);
    expect(fills.every((f) => f.allocation === 'yv1')).toBe(true);
    expect(otherTrades.map((t) => t.secCode)).toEqual(['SBMM']);
    // 05.11 мостом не покрыто — «нет в мосте» не ошибка; 06.11 сошлось до копейки
    expect(discrepancies).toEqual([]);
  });

  it('точный допуск: цена на 0.001 или количество на 1 — расхождение', () => {
    const shifted = qsnapTrades.map((t, i) => (i === 0 ? { ...t, price: '12.406' } : i === 1 ? { ...t, qty: '101' } : t));
    const { discrepancies } = buildFills({ qsnapTrades: shifted, automatTrades: automat, verifiableDates: new Set(['2026-11-06']) });
    expect(discrepancies.map((d) => d.kind).sort()).toEqual(['mismatch-price', 'mismatch-qty']);
  });

  it('время: 2 секунды допустимы, 3 — нет', () => {
    const at = (time: string) =>
      buildFills({
        qsnapTrades: qsnapTrades.map((t, i) => (i === 0 ? { ...t, time } : t)),
        automatTrades: automat,
        verifiableDates: new Set(),
      }).discrepancies.map((d) => d.kind);
    expect(at('10:20:02')).toEqual([]);
    expect(at('10:20:03')).toEqual(['mismatch-time']);
  });

  it('сделка автомата, которой нет в целом снимке той же даты, — расхождение; чужая дата — нет', () => {
    const { discrepancies } = buildFills({
      qsnapTrades: qsnapTrades.slice(1),
      automatTrades: automat,
      verifiableDates: new Set(['2026-11-06']),
    });
    expect(discrepancies.map((d) => d.kind)).toEqual(['only-in-automat']);
  });

  it('CR*-сделка не из журнала — «не распределено», с пометкой о времени входа/выхода', () => {
    const manual: SnapshotTrade = { ...qsnapTrades[0], tradeNum: '9', time: '13:00:10' };
    const { fills, discrepancies } = buildFills({ qsnapTrades: [manual], automatTrades: [], verifiableDates: new Set() });
    expect(fills[0]).toMatchObject({ allocation: 'unallocated', looksLikeSystem: true });
    expect(discrepancies[0].kind).toBe('manual-trade');
  });

  it('одна сделка в двух снимках — берётся последний, расхождение между снимками видно', () => {
    const later: SnapshotTrade = { ...qsnapTrades[0], snapId: '20261107_060000', price: '12.5' };
    const { discrepancies } = buildFills({ qsnapTrades: [qsnapTrades[0], later], automatTrades: [], verifiableDates: new Set() });
    expect(discrepancies.some((d) => d.kind === 'snapshot-conflict')).toBe(true);
  });
});

/* ------------------------------------------------------------------ циклы */

describe('циклы', () => {
  const automat = parseAutomatTrades(AUTOMAT_TRADES_CSV, 'yv1_trades.csv');
  const qsnapTrades: SnapshotTrade[] = extractTrades(snapshotTables()).map((t) => ({ ...t, snapId: '20261107_022914' }));
  const { fills } = buildFills({ qsnapTrades, automatTrades: automat, verifiableDates: new Set() });

  it('цикл 05→06.11 (шорт 128): результат по цене, издержки и net сходятся с ручным расчётом', () => {
    const { cycles, discrepancies } = buildCycles(fills);
    expect(discrepancies).toEqual([]);
    expect(cycles).toHaveLength(1);
    const c = cycles[0];
    expect(c).toMatchObject({ id: '2026-11-05', openDate: '2026-11-05', closeDate: '2026-11-06', status: 'closed', direction: 'short', entryQty: '128', exitQty: '128' });
    // 64 × (12.421 − 12.405) + 64 × (12.42 − 12.405) = 1024 + 960, × 1000 ₽
    expect(c.pnlPrice).toBe('1984.00');
    expect(c.costs).toMatchObject({
      brokerModel: '476.68', // по сделке, округление вверх
      brokerQuik: '1258.11', // оценка QUIK ≈ 2.64 × модель
      exchange: '84.48',
      clearing: '61.44',
      total: '622.60',
      complete: true,
    });
    expect(c.netRub).toBe('1361.40');
    expect(c.avgEntryPrice).toBe('12.420500');
    expect(c.avgExitPrice).toBe('12.405000');
  });

  it('проскальзывание входа считается против ref_price со знаком стороны', () => {
    const { cycles } = buildCycles(fills);
    // продажа 64 по 12.421 при ref 12.422: хуже на 0.001 × 64 × 1000
    expect(cycles[0].slipEntryRub).toBe('64.00');
    expect(cycles[0].slipEntryAutomatRub).toBe('64.00');
  });

  it('частичный выход оставляет цикл открытым, закрытая часть уже в результате', () => {
    const half = fills.filter((f) => f.tradeNum !== '2022430714489774750');
    const { cycles } = buildCycles(half);
    expect(cycles[0]).toMatchObject({ status: 'partial', exitQty: '28', openQty: '100', closeDate: null });
  });

  it('выход без позиции — ошибка в расхождениях, отдельный «сиротский» цикл', () => {
    const { cycles, discrepancies } = buildCycles(fills.filter((f) => f.reason === 'exit'));
    expect(discrepancies.some((d) => d.kind === 'exit-without-position')).toBe(true);
    expect(cycles[0].id).toBe('2026-11-06!exit');
  });

  it('смена контракта: выход в старом контракте не смешивается со входом дня в новом', () => {
    const fill = (o: Partial<Yv1Fill>): Yv1Fill => ({
      tradeNum: 't', orderNum: null, date: '2026-12-14', time: '13:00:00', contract: 'CRZ6', side: 'B', sideSource: 'automat',
      qty: '10', price: '12.000', value: '120000', brokerFeeQuik: null, exchangeFee: '0', clearingFee: '0', techCenterFee: '0',
      reason: 'h1', refPrice: null, slipRubAutomat: null, inBridge: false, inAutomat: true, snapId: null, allocation: 'yv1', looksLikeSystem: false, ...o,
    });
    const { cycles } = buildCycles([
      fill({ tradeNum: 'a', date: '2026-12-14', contract: 'CRZ6' }),
      fill({ tradeNum: 'b', date: '2026-12-15', time: '10:20:00', side: 'S', price: '12.100', reason: 'exit', contract: 'CRZ6' }),
      fill({ tradeNum: 'c', date: '2026-12-15', time: '13:00:00', contract: 'CRH7', price: '12.300' }),
    ]);
    expect(cycles.map((c) => [c.id, c.status, c.contracts])).toEqual([
      ['2026-12-14', 'closed', ['CRZ6']],
      ['2026-12-15', 'open', ['CRH7']],
    ]);
    expect(cycles[0].pnlPrice).toBe('1000.00'); // 10 × 0.1 × 1000
  });

  it('проценты по долгу: только за минусовые утренние остатки, выходные — по пятнице', () => {
    const series = new Map([['2026-11-06', '-1000']]); // пятница
    // пт, сб, вс → 3 суток × 1000 × 0.0006
    expect(debtInterest(series, '2026-11-06', '2026-11-09').toFixed(2)).toBe('1.80');
    expect(debtInterest(new Map([['2026-11-06', '500']]), '2026-11-06', '2026-11-09').toFixed(2)).toBe('0.00');
  });
});

/* ------------------------------------------------------------------ проверки */

describe('проверки точности', () => {
  it('тест полноты: изменение рублей Т1 = комиссии QUIK по ТС + фонд, невязка 0.00', () => {
    const tables = snapshotTables();
    const id = moneyIdentity({
      snapId: '20261107_022914',
      tradeDate: '2026-11-06',
      trades: extractTrades(tables),
      automatTradeNums: new Set(parseAutomatTrades(AUTOMAT_TRADES_CSV, 'f').map((t) => t.tradeNum)),
      money: extractAccountState(tables).money,
      holdings: extractAccountState(tables).holdings,
    });
    expect(id.delta).toBe('-1975.38');
    expect(Object.fromEntries(id.components.map((c) => [c.group, c.amountRub]))).toEqual({
      yv1: '-628.71',
      unallocated: '0.00',
      fund: '-1346.67', // −1346.40 сумма − 0.27 комиссия
      'vm-posted': '0.00',
    });
    expect(id.residual).toBe('0.00');
    expect(id.ok).toBe(true);
  });

  it('тест полноты: лишнее движение денег (пополнение) видно как невязка, а не сглаживается', () => {
    const tables = snapshotTables();
    const state = extractAccountState(tables);
    const id = moneyIdentity({
      snapId: 's',
      tradeDate: '2026-11-06',
      trades: extractTrades(tables),
      automatTradeNums: new Set(),
      money: state.money ? { ...state.money, t1Current: '5322.58' } : null,
      holdings: state.holdings,
    });
    expect(id.ok).toBe(false);
  });

  it('позиция снимка: startnet −128 + покупки 128 = totalnet 0; потерянная сделка ловится', () => {
    const tables = snapshotTables();
    const trades = extractTrades(tables);
    const holdings = extractAccountState(tables).holdings;
    expect(checkSnapshotPosition('s', trades, holdings)).toEqual([]);
    const lost = checkSnapshotPosition('s', trades.slice(1), holdings);
    expect(lost[0].kind).toBe('position-mismatch');
  });

  it('покрытие: нужен целый снимок ПОСЛЕ вечернего клиринга; дыры названы по причине', () => {
    const { snapshots } = assessment();
    const cov = checkCoverage({
      tradingDays: ['2026-11-05', '2026-11-06', '2026-11-09'],
      snapshots,
      now: '2026-11-09 09:00:00',
    });
    expect(cov.covered).toEqual(['2026-11-06']);
    expect(cov.holes).toEqual([{ date: '2026-11-05', reason: 'нет ни одного снимка за торговую дату' }]);
    // 09.11 до 19:10 дырой ещё не считается
    expect(cov.tradingDays).toContain('2026-11-09');
  });

  it('снимок до клиринга (раньше 19:10) день не закрывает', () => {
    const early = assessSnapshots(
      parseQsnapIndex(INDEX_TEXT.replace('2026-11-07 02:29:14', '2026-11-06 15:10:00')),
      new Map([['20261107_022914', 10]]),
    );
    const cov = checkCoverage({ tradingDays: ['2026-11-06'], snapshots: early.snapshots, now: '2026-11-07 10:00:00' });
    expect(cov.holes[0].reason).toMatch(/до вечернего клиринга/);
  });

  it('сигналы: пропущенная половина и частичное исполнение', () => {
    const signals = parseAutomatSignals(
      'date,contract,pre_gap,p0,h1_px,h1_rel,h1_s,h1_n,h1_filled,h1_skip,h2_px,h2_rel,h2_s,h2_n,h2_filled,h2_skip,dry_run\n' +
        '2026-11-04,CRZ6,0,12.414,12.357,-0.00459,-1,65,,,12.34,-0.00596,-1,65,-60,,false\n',
    );
    const out = checkSignals(signals, [], []);
    expect(out.map((d) => d.kind).sort()).toEqual(['missed-half', 'partial-fill', 'signal-fill-mismatch']);
  });

  it('halt из лога автомата попадает в расхождения', () => {
    const day = parseAutomatLog('10:20:00 [10:20:00] halt=1: исход заявки неизвестен\n', '2026-11-04');
    expect(checkSignals([], [], [day])[0].kind).toBe('halt');
  });
});

/* ------------------------------------------------------------------ журнал автомата */

describe('журнал автомата', () => {
  it('парсит строки «старт:» обеих форм размера', () => {
    const fixed = parseAutomatLog('13:39:11 [13:39:07] старт: DRY_RUN=false, на половину 2 шт, плечо 1.00, потолок 4, счёт ACC1/CL1, папка C:\\x\n', '2026-10-30');
    expect(fixed.sizing).toMatchObject({ halfQty: 2, capital: null, leverage: '1.00', maxGross: 4 });
    const cap = parseAutomatLog('10:40:48 [10:40:48] старт: DRY_RUN=false, на половину от капитала 1288500, плечо 1.25, потолок 134, счёт A/B, папка C:\\x\n', '2026-11-02');
    expect(cap.sizing).toMatchObject({ halfQty: null, capital: '1288500', leverage: '1.25', maxGross: 134 });
  });

  it('дневной итог: пустые значения → null, вариационная маржа читается как есть', () => {
    const [d] = parseAutomatDaily(
      'date,positions_overnight,t0_start,t0_next,cash_change,vm,vm_real,vm_total,fl_vm,fee_broker_quik,fee_exchange\n2026-10-29,4,198.89,685.27,486.38,572.0,0.0,0.0,,,1.12\n',
    );
    expect(d).toMatchObject({ date: '2026-10-29', vm: '572', feeBrokerQuik: null, feeExchange: '1.12' });
  });

  it('старые журналы без комиссий и с другой шапкой читаются', () => {
    const fills = parseAutomatTrades(
      'date,time,contract,side,qty,price,reason,ref_price,order_num,trade_num\n2026-10-29,13:40:00,CRZ6,B,2,12.27,h1,12.27,2022430693017071821,2022430693015062433\n',
      'yv1_fills.csv',
    );
    expect(fills[0]).toMatchObject({ brokerFeeQuik: null, exchangeFee: null, refPrice: '12.27' });
    const before = parseAutomatTrades(
      'date,time,contract,side,qty,price,reason,ref_price,slip_rub,slip_pct,broker_fee,exchange_fee,clearing_fee,techcenter_fee,order_num,trade_num\n2026-10-29,15:00:02,CRZ6,B,2,12.284,h2,12.283,2.00,0.0081,9.72,0.64,0.48,0.00,2022430693017262841,2022430693015076782\n',
      'before.csv',
    );
    expect(before[0]).toMatchObject({ brokerFeeQuik: '9.72', exchangeFee: '0.64' });
  });

  it('сторона не B/S — ошибка формата', () => {
    expect(() =>
      parseAutomatTrades('date,time,contract,side,qty,price,reason,order_num,trade_num\n2026-10-29,13:40:00,CRZ6,X,2,12.27,h1,1,2\n', 'f'),
    ).toThrow(/сторона/);
  });
});

/* ------------------------------------------------------------------ обзор целиком */

describe('обзор ЮВ1', () => {
  const automatTrades = parseAutomatTrades(AUTOMAT_TRADES_CSV, 'yv1_trades.csv');
  const input = () => ({
    now: '2026-11-07 03:00:00',
    snapshots: [{ assessment: assessment().snapshots[0], tables: snapshotTables() }],
    unfinished: [] as string[],
    automat: { trades: automatTrades, daily: [], signals: [], logs: [] },
    settings: { initialCapital: '1288500', feeRounding: 'ceil' as const, debtRatePerDay: '0.0006', backtestScale: null },
    backtest: null,
    corridor: null,
  });

  it('собирается из целого снимка и журнала: цикл, издержки, полнота, позиция, дыры', () => {
    const o = buildYv1Overview(input());
    expect(o.counts).toEqual({ fills: 6, yv1: 6, unallocated: 0, otherStrategy: 0, snapshotsComplete: 1 });
    expect(o.cycles[0].netRub).toBe('1361.40');
    expect(o.cycles[0].retInitialPct).toBeCloseTo(0.1057, 3); // 1361.40 / 1 288 500
    expect(o.costs.quikToModelRatio).toBeCloseTo(2.64, 2);
    expect(o.completeness[0].ok).toBe(true);
    expect(o.position).toMatchObject({ contract: 'CRZ6', bridgeNet: '0', journalNet: '0', lastPrice: '12.443', settlePrice: '12.442' });
    expect(o.bridge.coverage.holes.map((h) => h.date)).toEqual(['2026-11-05']);
    expect(o.vmDays).toEqual([{ date: '2026-11-06', valueRub: '-2304.00', status: 'accrued', source: 'bridge' }]);
    // циклов меньше 30 — вердикта нет
    expect(o.verdict.status).toBe('preliminary');
  });

  describe('сделка соседней стратегии на том же счёте', () => {
    const OTHER = '2022430714489774751';
    const withoutOther = () =>
      parseAutomatTrades(
        AUTOMAT_TRADES_CSV.split('\n').filter((l) => !l.includes(OTHER)).join('\n'),
        'yv1_trades.csv',
      );

    it('без сведений о соседях сделка вне журнала — «не распределено» и manual-trade (как раньше)', () => {
      const o = buildYv1Overview({ ...input(), automat: { trades: withoutOther(), daily: [], signals: [], logs: [] } });
      expect(o.counts).toMatchObject({ yv1: 5, unallocated: 1, otherStrategy: 0 });
      expect(o.discrepancies.some((d) => d.kind === 'manual-trade' && d.tradeNum === OTHER)).toBe(true);
    });

    it('номер из журнала другой стратегии: не наша, не «не распределено», без ложного manual-trade', () => {
      const o = buildYv1Overview({
        ...input(),
        automat: { trades: withoutOther(), daily: [], signals: [], logs: [] },
        otherStrategyTradeNums: new Set([OTHER]),
      });
      expect(o.counts).toMatchObject({ yv1: 5, unallocated: 0, otherStrategy: 1 });
      expect(o.discrepancies.some((d) => d.kind === 'manual-trade')).toBe(false);
      expect(o.counts.fills).toBe(5); // чужая сделка в сделки этой стратегии не входит
    });

    it('тест полноты сходится в обоих случаях; чужая сделка — своя группа, а не «не распределено»', () => {
      const base = { ...input(), automat: { trades: withoutOther(), daily: [], signals: [], logs: [] } };
      const plain = buildYv1Overview(base).completeness[0];
      const split = buildYv1Overview({ ...base, otherStrategyTradeNums: new Set([OTHER]) }).completeness[0];
      expect(plain.ok).toBe(true);
      expect(split.ok).toBe(true);
      expect(split.residual).toBe(plain.residual);
      const g = (id: typeof plain, group: string) => id.components.find((c) => c.group === group)?.amountRub;
      expect(g(plain, 'other-strategy')).toBeUndefined();
      expect(g(split, 'other-strategy')).toBe(g(plain, 'unallocated'));
      expect(g(split, 'unallocated')).toBe('0.00');
    });

    it('чужой номер, которого нет в снимке, ничего не меняет', () => {
      const a = buildYv1Overview(input());
      const b = buildYv1Overview({ ...input(), otherStrategyTradeNums: new Set(['999']) });
      expect(b).toEqual({ ...a, counts: { ...a.counts } });
    });
  });

  it('повторный расчёт на тех же входах даёт тот же результат (чистая функция)', () => {
    expect(buildYv1Overview(input())).toEqual(buildYv1Overview(input()));
  });

  it('нецелый снимок в расчёт не идёт, но виден в списке и в расхождениях', () => {
    const bad = assessSnapshots(parseQsnapIndex(INDEX_TEXT.replace(',ok,10,', ',ok,11,')), new Map([['20261107_022914', 10]]));
    const o = buildYv1Overview({ ...input(), snapshots: [{ assessment: bad.snapshots[0], tables: null }] });
    expect(o.counts.snapshotsComplete).toBe(0);
    expect(o.bridge.snapshots[0].complete).toBe(false);
    expect(o.discrepancies.some((d) => d.kind === 'incomplete-snapshot')).toBe(true);
    expect(o.bridge.lastComplete).toBeNull();
    // сделки идут только из журнала автомата
    expect(o.counts.fills).toBe(6);
  });

  it('кривая date,ret,equity: доходность дня = net закрытых циклов / капитал на начало дня', () => {
    const o = buildYv1Overview(input());
    const last = o.curve?.at(-1);
    expect(last?.date).toBe('2026-11-06');
    expect(last?.ret).toBeCloseTo(1361.4 / 1288500, 9);
    expect(last?.equity).toBeCloseTo(1 + 1361.4 / 1288500, 9);
    expect(curveToCsv(o.curve ?? []).split('\n')[0]).toBe('date,ret,equity');
  });

  it('без капитала доходность в % и кривая не считаются (null), рубли остаются', () => {
    const o = buildYv1Overview({ ...input(), settings: { ...input().settings, initialCapital: null } });
    expect(o.cycles[0].retInitialPct).toBeNull();
    expect(o.curve).toBeNull();
    expect(o.cycles[0].netRub).toBe('1361.40');
  });

  it('масштаб бэктеста: ret × множитель, equity пересобирается от 1', () => {
    const pts = scaleCurve([{ date: 'a', ret: 0.01 }, { date: 'b', ret: -0.02 }], '1.25');
    expect(pts[0].ret).toBeCloseTo(0.0125, 12);
    expect(pts[1].equity).toBeCloseTo(1.0125 * (1 - 0.025), 12);
  });
});

/* ------------------------------------------------------------------ регрессии по независимому ревью */

describe('регрессии ревью', () => {
  const mk = (o: Partial<Yv1Fill>): Yv1Fill => ({
    tradeNum: 't', orderNum: null, date: '2026-12-14', time: '13:00:00', contract: 'CRZ6', side: 'B', sideSource: 'automat',
    qty: '1', price: '12.000', value: '12000', brokerFeeQuik: null, exchangeFee: '0', clearingFee: '0', techCenterFee: '0',
    reason: 'h1', refPrice: null, slipRubAutomat: null, inBridge: false, inAutomat: true, snapId: null, allocation: 'yv1', looksLikeSystem: false, ...o,
  });

  const baseInput = (automat: ReturnType<typeof parseAutomatTrades>) => ({
    now: '2027-03-01 12:00:00',
    snapshots: [],
    unfinished: [] as string[],
    automat: { trades: automat, daily: [], signals: [], logs: [] },
    settings: { initialCapital: '1000000', feeRounding: 'ceil' as const, debtRatePerDay: '0.0006', backtestScale: null },
    backtest: null,
    exitRefPrices: undefined,
  });

  /** n закрытых циклов: вход B 1 контракт день d, выход S на следующий день */
  const closedCycles = (n: number): ReturnType<typeof parseAutomatTrades> => {
    const rows = ['date,time,contract,side,qty,price,reason,ref_price,order_num,trade_num'];
    for (let i = 0; i < n; i++) {
      const d1 = new Date(Date.UTC(2026, 0, 1 + i * 2)).toISOString().slice(0, 10);
      const d2 = new Date(Date.UTC(2026, 0, 2 + i * 2)).toISOString().slice(0, 10);
      rows.push(`${d1},13:00:00,CRZ6,B,1,12.0,h1,12.0,o${i}a,${1000 + i * 2}`);
      rows.push(`${d2},10:20:00,CRZ6,S,1,12.1,exit,,o${i}b,${1001 + i * 2}`);
    }
    return parseAutomatTrades(rows.join('\n') + '\n', 'f.csv');
  };

  it('коридор с обеими границами null — это «коридор не задан», а не «в коридоре»', () => {
    const o = buildYv1Overview({
      ...baseInput(closedCycles(31)),
      corridor: { minCycles: 30, netPerCycleRetPct: { min: null, max: null } },
    });
    expect(o.verdict.closedCycles).toBe(31);
    expect(o.verdict.status).toBe('no-corridor');
  });

  it('заданный коридор работает: выше границы — внутри, ниже — вне', () => {
    const base = baseInput(closedCycles(31));
    const inside = buildYv1Overview({ ...base, corridor: { minCycles: 30, netPerCycleRetPct: { min: 0, max: null } } });
    expect(inside.verdict.status).toBe('inside');
    const outside = buildYv1Overview({ ...base, corridor: { minCycles: 30, netPerCycleRetPct: { min: 5, max: null } } });
    expect(outside.verdict.status).toBe('outside');
  });

  it('после ролловера «Текущая позиция» — новый контракт, а не алфавитно последний', () => {
    const csv =
      'date,time,contract,side,qty,price,reason,ref_price,order_num,trade_num\n' +
      '2026-12-14,13:00:00,CRZ6,B,1,12.0,h1,12.0,a,1\n' +
      '2026-12-15,10:20:00,CRZ6,S,1,12.1,exit,,b,2\n' +
      '2026-12-15,13:00:00,CRH7,B,1,12.3,h1,12.3,c,3\n';
    const o = buildYv1Overview(baseInput(parseAutomatTrades(csv, 'f.csv')));
    expect(o.position).toMatchObject({ contract: 'CRH7', journalNet: '1' });
  });

  it('«исполнено» в сигналах ещё не дописано — частичного исполнения нет, если сделки покрывают план', () => {
    const signals = parseAutomatSignals(
      'date,contract,pre_gap,p0,h1_px,h1_rel,h1_s,h1_n,h1_filled,h1_skip,h2_px,h2_rel,h2_s,h2_n,h2_filled,h2_skip,dry_run\n' +
        '2026-11-04,CRZ6,0,12.4,12.3,-0.004,-1,65,,,12.3,0,0,0,,,false\n',
    );
    const f = mk({ date: '2026-11-04', side: 'S', qty: '65', reason: 'h1' });
    expect(checkSignals(signals, [f], []).map((d) => d.kind)).toEqual([]);
    const short = mk({ date: '2026-11-04', side: 'S', qty: '40', reason: 'h1' });
    expect(checkSignals(signals, [short], []).map((d) => d.kind)).toEqual(['partial-fill']);
  });

  it('«нет в мосте» не ошибка для сделки, совершённой позже последнего снимка дня', () => {
    const q: SnapshotTrade[] = extractTrades(snapshotTables()).map((t) => ({ ...t, snapId: 's' }));
    const automat = parseAutomatTrades(
      'date,time,contract,side,qty,price,reason,order_num,trade_num\n' +
        '2026-11-06,15:00:03,CRZ6,S,10,12.4,h2,o,777\n',
      'f.csv',
    );
    const early = buildFills({
      qsnapTrades: q,
      automatTrades: automat,
      verifiableDates: new Set(['2026-11-06']),
      verifiableUntil: new Map([['2026-11-06', '2026-11-06 14:00:00']]),
    });
    expect(early.discrepancies.filter((d) => d.kind === 'only-in-automat')).toEqual([]);
    const late = buildFills({
      qsnapTrades: q,
      automatTrades: automat,
      verifiableDates: new Set(['2026-11-06']),
      verifiableUntil: new Map([['2026-11-06', '2026-11-07 02:29:14']]),
    });
    expect(late.discrepancies.filter((d) => d.kind === 'only-in-automat')).toHaveLength(1);
  });

  it('тест полноты: сделка по другому фьючерсу (не CR*) — не сделка фонда, сумма сделки деньги не двигает', () => {
    const tables = snapshotTables();
    const trades = extractTrades(tables);
    const si = { ...trades[0], tradeNum: '555', secCode: 'SiZ6', classCode: 'SPBFUT', brokerFeeQuik: '2', value: '90000' };
    const state = extractAccountState(tables);
    const id = moneyIdentity({
      snapId: 's',
      tradeDate: '2026-11-06',
      trades: [...trades, si],
      automatTradeNums: new Set(parseAutomatTrades(AUTOMAT_TRADES_CSV, 'f').map((t) => t.tradeNum)),
      money: state.money,
      holdings: state.holdings,
    });
    // добавилась только комиссия 2.00 по не распределённой сделке, а не 90 000 ₽
    expect(id.components.find((c) => c.group === 'unallocated')?.amountRub).toBe('-2.00');
    expect(id.components.find((c) => c.group === 'fund')?.amountRub).toBe('-1346.67');
  });
});

