import Decimal from 'decimal.js';
import type { Yv1Fill } from './yv1-fills';
import { CONTRACT_MULTIPLIER, type Discrepancy, type Side } from './yv1-types';

Decimal.set({ precision: 40 });

/**
 * Циклы ТС ЮВ1·2вх: входы по половинам (h1 13:00, h2 15:00) → выход следующего торгового
 * дня в 10:20, с выходными и сменой контракта.
 *
 * Сопоставление входов и выходов — FIFO по каждому контракту: выход закрывает самые
 * старые открытые лоты. Цикл — это день открытия лота, поэтому выход, который закрывает
 * лоты вчерашнего цикла и тут же (в 13:00) вход нового дня, не смешивает циклы, а смена
 * контракта в день экспирации (вход в новый, выход из старого) разводится по контрактам.
 *
 * Результат по цене (`pnlPrice`) точен по ценам сделок и не зависит от того, как QUIK
 * разнёс вариационную маржу по клирингам. ВМ показывается отдельно, по дням счёта.
 */

/** Как округляется брокерская комиссия по одной сделке */
export type FeeRounding = 'ceil' | 'half-up';

/** Тариф Сбера на срочном рынке: 0.015 % от суммы сделки */
export const BROKER_RATE_CR = '0.00015';

/**
 * Дефолт — округление вверх до копейки: по эталону отчёта Сбера за 26–30.10 (3.69 +
 * 3.69 + 7.40 = 14.78) сходится точно, обычное округление даёт 14.77. Выбор подтверждён
 * тремя сделками — это гипотеза, проверяется на следующем отчёте (см. compareFeeRounding).
 */
export const DEFAULT_FEE_ROUNDING: FeeRounding = 'ceil';

/** Процент Сбера на долг от минусовой ВМ, в сутки (со слов пользователя 29.10, по документу не проверено) */
export const DEBT_RATE_PER_DAY = '0.0006';

export function modelBrokerFee(
  value: string,
  rounding: FeeRounding = DEFAULT_FEE_ROUNDING,
  rate: string = BROKER_RATE_CR,
): string {
  return new Decimal(value)
    .mul(rate)
    .toDecimalPlaces(2, rounding === 'ceil' ? Decimal.ROUND_UP : Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

/** Сумма модельной брокерской комиссии по набору сумм сделок при обоих способах округления */
export function compareFeeRounding(values: readonly string[]): { ceil: string; halfUp: string } {
  const sum = (mode: FeeRounding): string =>
    values.reduce((acc, v) => acc.plus(modelBrokerFee(v, mode)), new Decimal(0)).toFixed(2);
  return { ceil: sum('ceil'), halfUp: sum('half-up') };
}

export interface CycleLeg {
  tradeNum: string;
  date: string;
  time: string;
  contract: string;
  side: Side;
  role: 'entry' | 'exit';
  reason: string | null;
  /** сколько контрактов сделки относится к этому циклу (сделка может делиться между циклами) */
  qty: string;
  fillQty: string;
  price: string;
}

export interface CycleCosts {
  /** брокер по тарифу 0.015 % (модель, откалибрована по отчёту Сбера) */
  brokerModel: string;
  /** оценка QUIK — для сравнения, завышена */
  brokerQuik: string;
  exchange: string;
  clearing: string;
  techCenter: string;
  /** brokerModel + exchange + clearing + techCenter — то, что вычитается из результата */
  total: string;
  /** false, если у части сделок нет биржевой/клиринговой комиссии (автомат их не записал) */
  complete: boolean;
}

export interface Yv1Cycle {
  /** дата входа (YYYY-MM-DD); для «выхода без позиции» — `<дата>!exit` */
  id: string;
  openDate: string;
  closeDate: string | null;
  status: 'open' | 'partial' | 'closed';
  direction: 'long' | 'short' | 'mixed';
  contracts: string[];
  entryQty: string;
  exitQty: string;
  openQty: string;
  avgEntryPrice: string | null;
  avgExitPrice: string | null;
  legs: CycleLeg[];
  /** результат по ценам сделок для закрытой части, ₽ */
  pnlPrice: string;
  costs: CycleCosts;
  /** проценты по долгу от минусовой ВМ — модель, ₽ */
  debtInterest: string;
  /** pnlPrice − costs.total − debtInterest, ₽ */
  netRub: string;
  /** потери на входе относительно ref_price (положительное = хуже), ₽; null — нет ref_price */
  slipEntryRub: string | null;
  /** то же по расчёту автомата (поле slip_rub) для контроля */
  slipEntryAutomatRub: string | null;
  /** потери на выходе против open 10:20; null — цены 10:20 нет */
  slipExitRub: string | null;
  flags: string[];
}

interface Lot {
  fill: Yv1Fill;
  cycleId: string;
  sign: 1 | -1;
  remaining: Decimal;
}

interface MutableCycle {
  id: string;
  openDate: string;
  legQty: Map<string, { leg: CycleLeg; qty: Decimal }>;
  entryQty: Decimal;
  exitQty: Decimal;
  pnl: Decimal;
  signs: Set<number>;
  contracts: Set<string>;
  lastExitDate: string | null;
}

export interface BuildCyclesOptions {
  rounding?: FeeRounding;
  /** рубли Т0 по датам (утро) для модели процентов по долгу */
  rubSeries?: ReadonlyMap<string, string>;
  /** open свечи 10:20 по датам выхода — для проскальзывания выхода */
  exitRefPrices?: ReadonlyMap<string, string>;
  /** на какую дату считать проценты открытых циклов (по умолчанию — дата последней сделки) */
  asOfDate?: string;
  debtRatePerDay?: string;
}

const D = (v: string | null): Decimal => new Decimal(v ?? 0);

export function buildCycles(
  fills: readonly Yv1Fill[],
  opts: BuildCyclesOptions = {},
): { cycles: Yv1Cycle[]; discrepancies: Discrepancy[] } {
  const rounding = opts.rounding ?? DEFAULT_FEE_ROUNDING;
  const mult = new Decimal(CONTRACT_MULTIPLIER);
  const discrepancies: Discrepancy[] = [];

  const mine = fills
    .filter((f) => f.allocation === 'yv1')
    .slice()
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`) || a.tradeNum.localeCompare(b.tradeNum));

  const cycles = new Map<string, MutableCycle>();
  const lotsByContract = new Map<string, Lot[]>();
  const getCycle = (id: string, openDate: string): MutableCycle => {
    let c = cycles.get(id);
    if (!c) {
      c = {
        id,
        openDate,
        legQty: new Map(),
        entryQty: new Decimal(0),
        exitQty: new Decimal(0),
        pnl: new Decimal(0),
        signs: new Set(),
        contracts: new Set(),
        lastExitDate: null,
      };
      cycles.set(id, c);
    }
    return c;
  };
  const addLeg = (c: MutableCycle, fill: Yv1Fill, role: 'entry' | 'exit', qty: Decimal): void => {
    const key = `${fill.tradeNum}|${role}`;
    const prev = c.legQty.get(key);
    if (prev) {
      prev.qty = prev.qty.plus(qty);
      return;
    }
    c.legQty.set(key, {
      qty,
      leg: {
        tradeNum: fill.tradeNum,
        date: fill.date,
        time: fill.time,
        contract: fill.contract,
        side: fill.side as Side,
        role,
        reason: fill.reason,
        qty: '0',
        fillQty: fill.qty,
        price: fill.price,
      },
    });
    c.contracts.add(fill.contract);
  };

  for (const fill of mine) {
    if (fill.side === null) continue; // направление неизвестно — в расчёт не берём, оно уже в расхождениях
    const sign: 1 | -1 = fill.side === 'B' ? 1 : -1;
    const lots = lotsByContract.get(fill.contract) ?? [];
    lotsByContract.set(fill.contract, lots);
    let left = new Decimal(fill.qty);
    const price = new Decimal(fill.price);

    // 1) закрываем встречные лоты по FIFO
    while (left.gt(0) && lots.length > 0 && lots[0].sign !== sign) {
      const lot = lots[0];
      const m = Decimal.min(left, lot.remaining);
      const c = getCycle(lot.cycleId, lot.cycleId.slice(0, 10));
      c.pnl = c.pnl.plus(price.minus(lot.fill.price).mul(lot.sign).mul(m).mul(mult));
      c.exitQty = c.exitQty.plus(m);
      c.lastExitDate = fill.date;
      addLeg(c, fill, 'exit', m);
      if (fill.reason !== 'exit' && lot.fill.date !== fill.date) {
        discrepancies.push({
          kind: 'entry-closes-position',
          severity: 'warn',
          date: fill.date,
          tradeNum: fill.tradeNum,
          message: `Сделка ${fill.tradeNum} (${fill.reason ?? 'без причины'}) закрыла позицию, открытую ${lot.fill.date}, — ожидался выход в 10:20`,
        });
      }
      lot.remaining = lot.remaining.minus(m);
      left = left.minus(m);
      if (lot.remaining.isZero()) lots.shift();
    }

    // 2) остаток открывает новый лот нового цикла
    if (left.gt(0)) {
      const orphanExit = fill.reason === 'exit';
      if (orphanExit) {
        discrepancies.push({
          kind: 'exit-without-position',
          severity: 'error',
          date: fill.date,
          tradeNum: fill.tradeNum,
          message: `Сделка выхода ${fill.tradeNum} (${left.toFixed()} контр.) не нашла встречной позиции — вход потерян или торговали вручную`,
        });
      }
      const id = orphanExit ? `${fill.date}!exit` : fill.date;
      const c = getCycle(id, fill.date);
      c.entryQty = c.entryQty.plus(left);
      c.signs.add(sign);
      addLeg(c, fill, 'entry', left);
      lots.push({ fill, cycleId: id, sign, remaining: left });
    }

    if (fill.reason === 'exit' && !fill.time.startsWith('10:20:')) {
      discrepancies.push({
        kind: 'exit-not-1020',
        severity: 'warn',
        date: fill.date,
        tradeNum: fill.tradeNum,
        message: `Выход ${fill.tradeNum} исполнен в ${fill.time}, а не в 10:20`,
      });
    }
  }

  // 3) сборка итоговых циклов
  const fillsByNum = new Map(mine.map((f) => [f.tradeNum, f]));
  const lastTradeDate = mine.length > 0 ? mine[mine.length - 1].date : '';
  const asOf = opts.asOfDate ?? lastTradeDate;
  const rate = opts.debtRatePerDay ?? DEBT_RATE_PER_DAY;

  const out: Yv1Cycle[] = [];
  for (const c of [...cycles.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const legs: CycleLeg[] = [];
    let brokerModel = new Decimal(0);
    let brokerQuik = new Decimal(0);
    let exchange = new Decimal(0);
    let clearing = new Decimal(0);
    let techCenter = new Decimal(0);
    let complete = true;
    let entrySlip = new Decimal(0);
    let entrySlipLegs = 0;
    let entryLegsTotal = 0;
    let exitSlip = new Decimal(0);
    let exitSlipLegs = 0;
    let exitLegsTotal = 0;
    let slipAutomat = new Decimal(0);
    let slipAutomatLegs = 0;
    let entryNotional = new Decimal(0);
    let exitNotional = new Decimal(0);
    let exitQtyForAvg = new Decimal(0);

    for (const { leg, qty } of c.legQty.values()) {
      const fill = fillsByNum.get(leg.tradeNum) as Yv1Fill;
      const share = qty.div(fill.qty);
      legs.push({ ...leg, qty: qty.toFixed() });

      brokerModel = brokerModel.plus(new Decimal(modelBrokerFee(fill.value, rounding)).mul(share));
      brokerQuik = brokerQuik.plus(D(fill.brokerFeeQuik).mul(share));
      if (fill.exchangeFee === null || fill.clearingFee === null) complete = false;
      exchange = exchange.plus(D(fill.exchangeFee).mul(share));
      clearing = clearing.plus(D(fill.clearingFee).mul(share));
      techCenter = techCenter.plus(D(fill.techCenterFee).mul(share));

      if (leg.role === 'entry') {
        entryNotional = entryNotional.plus(qty.mul(leg.price));
        entryLegsTotal++;
        if (fill.refPrice !== null) {
          const diff = leg.side === 'B' ? D(leg.price).minus(fill.refPrice) : D(fill.refPrice).minus(leg.price);
          entrySlip = entrySlip.plus(diff.mul(qty).mul(mult));
          entrySlipLegs++;
        }
        if (fill.slipRubAutomat !== null) {
          slipAutomat = slipAutomat.plus(D(fill.slipRubAutomat).mul(share));
          slipAutomatLegs++;
        }
      } else {
        exitNotional = exitNotional.plus(qty.mul(leg.price));
        exitQtyForAvg = exitQtyForAvg.plus(qty);
        exitLegsTotal++;
        const ref = opts.exitRefPrices?.get(leg.date);
        if (ref !== undefined) {
          const diff = leg.side === 'B' ? D(leg.price).minus(ref) : D(ref).minus(leg.price);
          exitSlip = exitSlip.plus(diff.mul(qty).mul(mult));
          exitSlipLegs++;
        }
      }
    }
    legs.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

    const openQty = c.entryQty.minus(c.exitQty);
    const status: Yv1Cycle['status'] = openQty.isZero() ? 'closed' : c.exitQty.isZero() ? 'open' : 'partial';
    const closeDate = status === 'closed' ? c.lastExitDate : null;

    const total = brokerModel.plus(exchange).plus(clearing).plus(techCenter);
    const interest = debtInterest(opts.rubSeries, c.openDate, closeDate ?? (asOf || c.openDate), rate);
    const flags: string[] = [];
    if (!complete) flags.push('fees-incomplete');
    if (entrySlipLegs < entryLegsTotal) flags.push('slippage-partial');
    if (status !== 'closed') flags.push('not-closed');

    if (!complete) {
      discrepancies.push({
        kind: 'fees-incomplete',
        severity: 'info',
        date: c.openDate,
        tradeNum: null,
        message: `Цикл ${c.id}: у части сделок нет биржевой/клиринговой комиссии — итог занижен на эти сборы`,
      });
    }

    out.push({
      id: c.id,
      openDate: c.openDate,
      closeDate,
      status,
      direction: c.signs.size === 0 ? 'long' : c.signs.size > 1 ? 'mixed' : c.signs.has(1) ? 'long' : 'short',
      contracts: [...c.contracts].sort(),
      entryQty: c.entryQty.toFixed(),
      exitQty: c.exitQty.toFixed(),
      openQty: openQty.toFixed(),
      avgEntryPrice: c.entryQty.isZero() ? null : entryNotional.div(c.entryQty).toFixed(6),
      avgExitPrice: exitQtyForAvg.isZero() ? null : exitNotional.div(exitQtyForAvg).toFixed(6),
      legs,
      pnlPrice: c.pnl.toFixed(2),
      costs: {
        brokerModel: brokerModel.toFixed(2),
        brokerQuik: brokerQuik.toFixed(2),
        exchange: exchange.toFixed(2),
        clearing: clearing.toFixed(2),
        techCenter: techCenter.toFixed(2),
        total: total.toFixed(2),
        complete,
      },
      debtInterest: interest.toFixed(2),
      netRub: c.pnl.minus(total).minus(interest).toFixed(2),
      slipEntryRub: entrySlipLegs === 0 ? null : entrySlip.toFixed(2),
      slipEntryAutomatRub: slipAutomatLegs === 0 ? null : slipAutomat.toFixed(2),
      slipExitRub: exitSlipLegs === 0 || exitSlipLegs < exitLegsTotal ? null : exitSlip.toFixed(2),
      flags,
    });
  }

  return { cycles: out, discrepancies };
}

/**
 * Проценты по долгу от минусовой ВМ: за каждые календарные сутки [from; to) долг =
 * max(0, −рубли Т0 утром последнего известного дня) × ставка. Выходные берут значение
 * пятницы. Это модель на утренних остатках: внутридневной минус она не видит.
 */
export function debtInterest(
  rubSeries: ReadonlyMap<string, string> | undefined,
  from: string,
  to: string,
  ratePerDay: string = DEBT_RATE_PER_DAY,
): Decimal {
  if (!rubSeries || rubSeries.size === 0 || to <= from) return new Decimal(0);
  const dates = [...rubSeries.keys()].sort();
  let total = new Decimal(0);
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) < to; d = new Date(d.getTime() + 86400000)) {
    const day = d.toISOString().slice(0, 10);
    let known: string | undefined;
    for (const k of dates) {
      if (k <= day) known = k;
      else break;
    }
    if (known === undefined) continue;
    const rub = new Decimal(rubSeries.get(known) as string);
    if (rub.lt(0)) total = total.plus(rub.neg().mul(ratePerDay));
  }
  return total;
}
