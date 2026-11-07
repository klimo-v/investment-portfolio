import Decimal from 'decimal.js';
import type { Operation } from './schemas';
import { applyFutureFill, type FuturePosition } from './futures-engine';
import { compareOperations } from './operation-order';

/**
 * Движок расчётов позиций. Единственный источник финансовой логики (SRP, CLAUDE.md §7).
 * Работает на decimal.js — деньги никогда не считаются во float (CLAUDE.md §11).
 *
 * Метод учёта по умолчанию — средневзвешенная цена (как в текущих данных
 * пользователя). Средняя считается по ОСТАВШИМСЯ лотам; «вложено» — нетто с учётом
 * частичных продаж (см. docs/02-data-model.md §4 и нюанс SBER).
 */

Decimal.set({ precision: 40 });

/**
 * Параметры расчёта. Движок не знает типов инструментов (в операции только
 * instrumentId), поэтому набор фьючерсных id приходит снаружи: для них включается
 * учёт позиции со знаком (futures-engine.ts), остальные считаются как раньше.
 */
export interface EngineOptions {
  futureIds?: ReadonlySet<string>;
}

export interface PositionResult {
  instrumentId: string;
  systemId: string;
  portfolioId: string;
  /** текущее количество */
  quantity: Decimal;
  /** средневзвешенная цена оставшихся лотов */
  avgBuyPrice: Decimal;
  /** вложенный капитал (нетто, с комиссией) в валюте инструмента */
  investedCcy: Decimal;
  /** вложено в рублях (по историческим курсам) */
  investedRub: Decimal;
  /** реализованный P&L в валюте инструмента */
  realizedPnlCcy: Decimal;
  /** реализованный P&L в рублях, по курсу на дату каждой продажи */
  realizedPnlRub: Decimal;
  /** накопленные дивиденды в рублях */
  dividendsRub: Decimal;
  /** накопленные купоны в рублях */
  couponsRub: Decimal;
  /**
   * Валюта, в которой выражены avgBuyPrice / investedCcy / realizedPnlCcy, —
   * это валюта СДЕЛОК, а не валюта номинала инструмента, и совпадать они не обязаны.
   * Замещающая долларовая облигация покупается за рубли: номинал у неё в USD,
   * а средняя цена в журнале — в рублях. Без этого поля интерфейс подписывал
   * среднюю валютой инструмента и показывал «8 452,21 $» там, где рубли.
   */
  tradeCurrency: string;
}

/** Исходные данные рыночной оценки остатка (см. marketValueRub) */
export interface MarketValueInput {
  quantity: Decimal.Value;
  /** «чистая» цена одной бумаги в валюте КОТИРОВКИ */
  price: Decimal.Value;
  /** курс валюты КОТИРОВКИ к рублю */
  fxRate: Decimal.Value;
  /** НКД на одну бумагу; null — не облигация */
  accruedInterest?: Decimal.Value | null;
  /**
   * Курс валюты НКД к рублю. Отдельный от fxRate, потому что валюты у цены и у
   * НКД разные и это НЕ край случай: замещающая облигация котируется в валюте
   * номинала (USD), а НКД биржа отдаёт в валюте расчётов режима торгов (рубли на
   * TQCB). Пересчёт НКД по курсу доллара завышал стоимость в 84 раза
   * (63 646,96 ₽ вместо 755,17 ₽ на 28 бумагах RU000A10B4K3).
   * По умолчанию — курс цены, то есть «валюты совпадают».
   */
  accruedFxRate?: Decimal.Value | null;
}

/**
 * Рыночная стоимость остатка в рублях — единая формула для позиций, сделок и
 * снимков (DRY: раньше она была продублирована в operations.service.ts и молча
 * разъезжалась между страницами).
 *
 * НКД входит в стоимость, потому что при продаже облигации накопленный купон
 * платит покупатель — это уже ваши деньги, и именно так считает брокер. Биржа
 * котирует облигации «чисто», без НКД, поэтому без этого слагаемого оценка
 * занижена тем сильнее, чем ближе купон (на 40 бумагах SU29008RMFS8 при НКД
 * 60,24 ₽ — 2 409,60 ₽ разницы). Двойного счёта с couponsRub нет: там уже
 * ВЫПЛАЧЕННЫЕ купоны, здесь — ещё не выплаченный накопленный.
 */
export function marketValueRub(input: MarketValueInput): Decimal {
  const priceRub = new Decimal(input.price).mul(input.fxRate);
  const accruedRub = new Decimal(input.accruedInterest ?? 0).mul(
    input.accruedFxRate ?? input.fxRate,
  );
  return new Decimal(input.quantity).mul(priceRub.plus(accruedRub));
}

/** Ключ позиции: инструмент × система × портфель */
function positionKey(op: Operation): string {
  return `${op.instrumentId}|${op.systemId}|${op.portfolioId}`;
}

function d(value: string): Decimal {
  return new Decimal(value);
}

/**
 * Считает позиции из журнала операций методом средневзвешенной цены.
 * Переводы между портфелями (Transfer) не влияют на P&L инструмента.
 */
export function calculatePositions(
  operations: Operation[],
  options: EngineOptions = {},
): PositionResult[] {
  const map = new Map<string, PositionResult>();

  // операции обрабатываем в хронологическом порядке
  const sorted = [...operations].sort(compareOperations);

  for (const op of sorted) {
    // кэш-операции и переводы без инструмента не создают позицию
    if (!op.instrumentId) continue;
    if (op.operationType === 'Transfer') continue;

    const key = positionKey(op);
    let pos = map.get(key);
    if (!pos) {
      pos = {
        instrumentId: op.instrumentId,
        systemId: op.systemId,
        portfolioId: op.portfolioId,
        quantity: new Decimal(0),
        avgBuyPrice: new Decimal(0),
        investedCcy: new Decimal(0),
        investedRub: new Decimal(0),
        realizedPnlCcy: new Decimal(0),
        realizedPnlRub: new Decimal(0),
        dividendsRub: new Decimal(0),
        couponsRub: new Decimal(0),
        tradeCurrency: op.currency,
      };
      map.set(key, pos);
    }

    const qty = d(op.quantity);
    const price = d(op.price);
    const fee = d(op.fee ?? '0');
    const fxRate = d(op.fxRate ?? '1');

    // фьючерс: позиция со знаком, комиссия сразу в реализованном; «вложено» = 0
    if (options.futureIds?.has(op.instrumentId)) {
      if (op.operationType === 'Buy' || op.operationType === 'Sell') {
        pos.tradeCurrency = op.currency;
        const fill = applyFutureFill(pos, op.operationType, qty, price, fee);
        const net = fill.pnlCcy.minus(fill.feeCcy);
        pos.realizedPnlCcy = pos.realizedPnlCcy.plus(net);
        pos.realizedPnlRub = pos.realizedPnlRub.plus(net.mul(fxRate));
      }
      continue;
    }

    switch (op.operationType) {
      case 'Buy': {
        const cost = qty.mul(price).plus(fee);
        // среднюю формируют ОСТАВШИЕСЯ лоты, поэтому валюта — из последней покупки:
        // если бумагу когда-то брали за другую валюту, актуальна валюта тех лотов,
        // что сейчас в остатке
        pos.tradeCurrency = op.currency;
        pos.investedCcy = pos.investedCcy.plus(cost);
        pos.investedRub = pos.investedRub.plus(cost.mul(fxRate));
        pos.quantity = pos.quantity.plus(qty);
        // средневзвешенная по оставшимся лотам
        pos.avgBuyPrice = pos.quantity.isZero()
          ? new Decimal(0)
          : pos.investedCcy.div(pos.quantity);
        break;
      }
      case 'Sell': {
        // себестоимость проданной части по средней цене
        const costOfSold = pos.avgBuyPrice.mul(qty);
        const proceeds = qty.mul(price).minus(fee);
        pos.realizedPnlCcy = pos.realizedPnlCcy.plus(proceeds.minus(costOfSold));
        pos.realizedPnlRub = pos.realizedPnlRub.plus(proceeds.minus(costOfSold).mul(fxRate));
        pos.quantity = pos.quantity.minus(qty);
        // вложено уменьшается на себестоимость проданного (нетто-остаток)
        pos.investedCcy = pos.investedCcy.minus(costOfSold);
        pos.investedRub = pos.investedRub.minus(costOfSold.mul(fxRate));
        // средняя цена остатка не меняется при продаже по средней
        if (pos.quantity.lte(0)) {
          pos.quantity = new Decimal(0);
          pos.investedCcy = new Decimal(0);
          pos.investedRub = new Decimal(0);
          pos.avgBuyPrice = new Decimal(0);
        }
        break;
      }
      case 'Dividend': {
        // сумма дивиденда приходит в price*quantity или в price (кол-во=1)
        pos.dividendsRub = pos.dividendsRub.plus(qty.mul(price).mul(fxRate));
        break;
      }
      case 'Coupon': {
        pos.couponsRub = pos.couponsRub.plus(qty.mul(price).mul(fxRate));
        break;
      }
      // Tax/Fee по инструменту при желании учитываются отдельно; в MVP — в P&L сделки
      default:
        break;
    }
  }

  return [...map.values()];
}

export interface RealizedInRangeResult {
  instrumentId: string;
  systemId: string;
  portfolioId: string;
  /** реализованный P&L в рублях от продаж, попавших в [from, till] */
  realizedPnlRub: Decimal;
}

/**
 * Реализованный P&L ИМЕННО от продаж внутри [from, till] (включительно, YYYY-MM-DD),
 * а не за всё время (в отличие от calculatePositions()/calculateTrades()). Средняя
 * цена лота на момент каждой продажи всё равно считается по ПОЛНОЙ истории покупок
 * до неё (`operations` должны содержать её всю, а не только срез периода) — иначе
 * себестоимость проданного была бы искажена, если покупка была до начала периода.
 * Нужна для периодного среза «Эффективности» на дашборде (operations.service.ts).
 */
export function realizedPnlInRange(
  operations: Operation[],
  from?: string,
  till?: string,
  options: EngineOptions = {},
): RealizedInRangeResult[] {
  const map = new Map<
    string,
    {
      instrumentId: string;
      systemId: string;
      portfolioId: string;
      avgBuyPrice: Decimal;
      quantity: Decimal;
      realizedPnlRub: Decimal;
    }
  >();

  const sorted = [...operations]
    .filter((op) => !till || op.date <= till)
    .sort(compareOperations);

  for (const op of sorted) {
    if (!op.instrumentId) continue;
    if (op.operationType === 'Transfer') continue;

    const key = positionKey(op);
    let pos = map.get(key);
    if (!pos) {
      pos = {
        instrumentId: op.instrumentId,
        systemId: op.systemId,
        portfolioId: op.portfolioId,
        avgBuyPrice: new Decimal(0),
        quantity: new Decimal(0),
        realizedPnlRub: new Decimal(0),
      };
      map.set(key, pos);
    }

    const qty = d(op.quantity);
    const price = d(op.price);
    const fee = d(op.fee ?? '0');
    const fxRate = d(op.fxRate ?? '1');

    if (options.futureIds?.has(op.instrumentId)) {
      if (op.operationType === 'Buy' || op.operationType === 'Sell') {
        const fill = applyFutureFill(pos, op.operationType, qty, price, fee);
        // результат с комиссией попадает в период по дате самой сделки
        if (!from || op.date >= from) {
          pos.realizedPnlRub = pos.realizedPnlRub.plus(fill.pnlCcy.minus(fill.feeCcy).mul(fxRate));
        }
      }
      continue;
    }

    if (op.operationType === 'Buy') {
      const cost = qty.mul(price).plus(fee);
      const investedCcy = pos.avgBuyPrice.mul(pos.quantity).plus(cost);
      pos.quantity = pos.quantity.plus(qty);
      pos.avgBuyPrice = pos.quantity.isZero() ? new Decimal(0) : investedCcy.div(pos.quantity);
    } else if (op.operationType === 'Sell') {
      const costOfSold = pos.avgBuyPrice.mul(qty);
      const proceeds = qty.mul(price).minus(fee);
      if (!from || op.date >= from) {
        pos.realizedPnlRub = pos.realizedPnlRub.plus(proceeds.minus(costOfSold).mul(fxRate));
      }
      pos.quantity = pos.quantity.minus(qty);
      if (pos.quantity.lte(0)) {
        pos.quantity = new Decimal(0);
        pos.avgBuyPrice = new Decimal(0);
      }
    }
  }

  return [...map.values()].map(({ instrumentId, systemId, portfolioId, realizedPnlRub }) => ({
    instrumentId,
    systemId,
    portfolioId,
    realizedPnlRub,
  }));
}

/** Нереализованный P&L позиции по текущей цене (в валюте инструмента) */
export function unrealizedPnl(pos: PositionResult, currentPrice: Decimal): Decimal {
  const currentValue = pos.quantity.mul(currentPrice);
  return currentValue.minus(pos.investedCcy);
}

/**
 * Денежное событие сделки на дату: единый источник и для итога сделки, и для дневной
 * кривой результата системы (сумма событий сделки = realizedPnlRub + дивиденды + купоны).
 * Спот: продажа (в т.ч. частичная) — realized, дивиденд/купон — income; фьючерс —
 * каждое исполнение (результат минус комиссия) — realized.
 */
export interface TradeEvent {
  date: string;
  kind: 'realized' | 'income';
  rub: Decimal;
}

export interface TradeResult {
  instrumentId: string;
  systemId: string;
  portfolioId: string;
  status: 'Open' | 'Partial' | 'Closed';
  /** остаток (0 у закрытой сделки) */
  quantity: Decimal;
  qtyBought: Decimal;
  qtySold: Decimal;
  /** средневзвешенная цена оставшихся лотов */
  avgBuyPrice: Decimal;
  investedCcy: Decimal;
  investedRub: Decimal;
  proceedsCcy: Decimal;
  proceedsRub: Decimal;
  realizedPnlCcy: Decimal;
  /** реализованный P&L в рублях, по курсу на дату каждой продажи */
  realizedPnlRub: Decimal;
  dividendsRub: Decimal;
  couponsRub: Decimal;
  /** валюта сделок — в ней выражены avgBuyPrice/investedCcy (см. PositionResult.tradeCurrency) */
  tradeCurrency: string;
  /** направление: у не-фьючерсов всегда Long; у фьючерса — по знаку позиции при открытии */
  direction: 'Long' | 'Short';
  openedAt: string;
  closedAt: string | null;
  /** время открытия «ЧЧ:ММ:СС» (executedAt первой операции); null у старых операций без времени */
  openedTime: string | null;
  /** время закрытия «ЧЧ:ММ:СС»; null — сделка открыта или у операции нет времени */
  closedTime: string | null;
  /**
   * Комиссии всех операций сделки в рублях (для «доли комиссий»). Уже учтены в
   * realizedPnlRub: gross = realizedPnlRub + feesRub (у закрытой сделки).
   */
  feesRub: Decimal;
  /** id операций, из которых собрана сделка */
  operationIds: string[];
  /** зафиксированные денежные события по датам (см. TradeEvent) */
  events: TradeEvent[];
}

function newTrade(
  op: Operation,
  direction: 'Long' | 'Short',
): TradeResult {
  return {
    instrumentId: op.instrumentId as string,
    systemId: op.systemId,
    portfolioId: op.portfolioId,
    status: 'Open',
    quantity: new Decimal(0),
    qtyBought: new Decimal(0),
    qtySold: new Decimal(0),
    avgBuyPrice: new Decimal(0),
    investedCcy: new Decimal(0),
    investedRub: new Decimal(0),
    proceedsCcy: new Decimal(0),
    proceedsRub: new Decimal(0),
    realizedPnlCcy: new Decimal(0),
    realizedPnlRub: new Decimal(0),
    dividendsRub: new Decimal(0),
    couponsRub: new Decimal(0),
    tradeCurrency: op.currency,
    direction,
    openedAt: op.date,
    closedAt: null,
    openedTime: op.executedAt ?? null,
    closedTime: null,
    feesRub: new Decimal(0),
    operationIds: [],
    events: [],
  };
}

/**
 * Группирует операции одного инструмента (в рамках системы/портфеля) в сделки
 * (docs/02-data-model.md §2.5): сделка открывается первой покупкой и закрывается,
 * когда остаток уходит в ноль. Если позиция открывается заново после закрытия —
 * это уже новая сделка (реальный кейс: купил-продал-купил снова).
 */
export function calculateTrades(
  operations: Operation[],
  options: EngineOptions = {},
): TradeResult[] {
  const closed: TradeResult[] = [];
  const open = new Map<string, TradeResult>();

  const sorted = [...operations].sort(compareOperations);
  // позиция фьючерса по ключу (нужна, чтобы применять сделки по порядку)
  const futurePos = new Map<string, FuturePosition>();

  for (const op of sorted) {
    if (!op.instrumentId) continue;
    if (op.operationType === 'Transfer') continue;

    const key = positionKey(op);
    const qty = d(op.quantity);
    const price = d(op.price);
    const fee = d(op.fee ?? '0');
    const fxRate = d(op.fxRate ?? '1');

    if (options.futureIds?.has(op.instrumentId)) {
      if (op.operationType === 'Buy' || op.operationType === 'Sell') {
        applyFutureTrade(op, op.operationType, qty, price, fee, fxRate, key, futurePos, open, closed);
      }
      continue;
    }

    if (op.operationType === 'Buy') {
      let trade = open.get(key);
      if (!trade) {
        trade = newTrade(op, 'Long');
        open.set(key, trade);
      }
      trade.tradeCurrency = op.currency;
      const cost = qty.mul(price).plus(fee);
      trade.investedCcy = trade.investedCcy.plus(cost);
      trade.investedRub = trade.investedRub.plus(cost.mul(fxRate));
      trade.feesRub = trade.feesRub.plus(fee.mul(fxRate));
      trade.quantity = trade.quantity.plus(qty);
      trade.qtyBought = trade.qtyBought.plus(qty);
      trade.avgBuyPrice = trade.quantity.isZero()
        ? new Decimal(0)
        : trade.investedCcy.div(trade.quantity);
      if (op.id) trade.operationIds.push(op.id);
      continue;
    }

    if (op.operationType === 'Sell') {
      const trade = open.get(key);
      if (!trade) continue; // продажа без открытой сделки — некорректные данные, пропускаем

      const costOfSold = trade.avgBuyPrice.mul(qty);
      const proceeds = qty.mul(price).minus(fee);
      trade.realizedPnlCcy = trade.realizedPnlCcy.plus(proceeds.minus(costOfSold));
      trade.realizedPnlRub = trade.realizedPnlRub.plus(proceeds.minus(costOfSold).mul(fxRate));
      trade.events.push({ date: op.date, kind: 'realized', rub: proceeds.minus(costOfSold).mul(fxRate) });
      trade.proceedsCcy = trade.proceedsCcy.plus(proceeds);
      trade.proceedsRub = trade.proceedsRub.plus(proceeds.mul(fxRate));
      trade.investedCcy = trade.investedCcy.minus(costOfSold);
      trade.investedRub = trade.investedRub.minus(costOfSold.mul(fxRate));
      trade.quantity = trade.quantity.minus(qty);
      trade.qtySold = trade.qtySold.plus(qty);
      trade.feesRub = trade.feesRub.plus(fee.mul(fxRate));
      if (op.id) trade.operationIds.push(op.id);

      if (trade.quantity.lte(0)) {
        trade.quantity = new Decimal(0);
        trade.investedCcy = new Decimal(0);
        trade.investedRub = new Decimal(0);
        trade.status = 'Closed';
        trade.closedAt = op.date;
        trade.closedTime = op.executedAt ?? null;
        open.delete(key);
        closed.push(trade);
      } else {
        trade.status = 'Partial';
      }
      continue;
    }

    if (op.operationType === 'Dividend' || op.operationType === 'Coupon') {
      const trade = open.get(key);
      if (!trade) continue; // выплата по уже закрытой сделке — не относим никуда
      const amount = qty.mul(price).mul(fxRate);
      if (op.operationType === 'Dividend') trade.dividendsRub = trade.dividendsRub.plus(amount);
      else trade.couponsRub = trade.couponsRub.plus(amount);
      trade.events.push({ date: op.date, kind: 'income', rub: amount });
      if (op.id) trade.operationIds.push(op.id);
    }
  }

  return [...closed, ...open.values()];
}

/**
 * Фьючерсная сделка в терминах «сделок» (trades): открывается, когда позиция уходит
 * из нуля (в любую сторону), закрывается, когда возвращается в ноль. Переворот через
 * ноль закрывает текущую сделку и открывает новую на остаток; комиссия делится
 * пропорционально количеству. `quantity` у сделки — остаток со знаком, «вложено» = 0.
 */
function applyFutureTrade(
  op: Operation,
  side: 'Buy' | 'Sell',
  qty: Decimal,
  price: Decimal,
  fee: Decimal,
  fxRate: Decimal,
  key: string,
  futurePos: Map<string, FuturePosition>,
  open: Map<string, TradeResult>,
  closed: TradeResult[],
): void {
  let pos = futurePos.get(key);
  if (!pos) {
    pos = { quantity: new Decimal(0), avgBuyPrice: new Decimal(0) };
    futurePos.set(key, pos);
  }

  const before = pos.quantity;
  // часть сделки, закрывающая позицию, и часть, открывающая новую (при перевороте)
  const closingQty = before.isZero()
    ? new Decimal(0)
    : before.isPositive() === (side === 'Buy')
      ? new Decimal(0)
      : Decimal.min(qty, before.abs());
  const feeClose = qty.isZero() ? new Decimal(0) : fee.mul(closingQty).div(qty);
  const feeOpen = fee.minus(feeClose);

  const record = (trade: TradeResult, partQty: Decimal, partFee: Decimal, pnl: Decimal): void => {
    const net = pnl.minus(partFee);
    trade.realizedPnlCcy = trade.realizedPnlCcy.plus(net);
    trade.realizedPnlRub = trade.realizedPnlRub.plus(net.mul(fxRate));
    if (!net.isZero()) trade.events.push({ date: op.date, kind: 'realized', rub: net.mul(fxRate) });
    trade.feesRub = trade.feesRub.plus(partFee.mul(fxRate));
    if (side === 'Buy') trade.qtyBought = trade.qtyBought.plus(partQty);
    else trade.qtySold = trade.qtySold.plus(partQty);
    if (op.id && !trade.operationIds.includes(op.id)) trade.operationIds.push(op.id);
  };

  const fill = applyFutureFill(pos, side, qty, price, fee);

  // 1) закрывающая часть — в уже открытую сделку
  if (fill.closedQty.gt(0)) {
    const trade = open.get(key);
    if (trade) {
      record(trade, fill.closedQty, feeClose, fill.pnlCcy);
      trade.quantity = pos.quantity.isZero() || fill.openedQty.gt(0) ? new Decimal(0) : pos.quantity;
      if (pos.quantity.isZero() || fill.openedQty.gt(0)) {
        trade.status = 'Closed';
        trade.closedAt = op.date;
        trade.closedTime = op.executedAt ?? null;
        open.delete(key);
        closed.push(trade);
      } else {
        // «Partial» = по сделке уже были закрытия; последующее наращивание статус не
        // сбрасывает (qtySold/qtyBought показывают историю)
        trade.status = 'Partial';
        trade.avgBuyPrice = pos.avgBuyPrice;
      }
    }
  }

  // 2) открывающая часть — в новую сделку (первое открытие или остаток после переворота)
  //    либо наращивание уже открытой
  if (fill.openedQty.gt(0)) {
    let trade = open.get(key);
    if (!trade) {
      // направление — по стороне открывающей части: Buy открывает лонг, Sell — шорт
      trade = newTrade(op, side === 'Buy' ? 'Long' : 'Short');
      open.set(key, trade);
    }
    record(trade, fill.openedQty, feeOpen, new Decimal(0));
    trade.quantity = pos.quantity;
    trade.avgBuyPrice = pos.avgBuyPrice;
  }
}
