import Decimal from 'decimal.js';
import type { Operation } from './schemas';

/**
 * Движок расчётов позиций. Единственный источник финансовой логики (SRP, CLAUDE.md §7).
 * Работает на decimal.js — деньги никогда не считаются во float (CLAUDE.md §11).
 *
 * Метод учёта по умолчанию — средневзвешенная цена (как в текущих данных
 * пользователя). Средняя считается по ОСТАВШИМСЯ лотам; «вложено» — нетто с учётом
 * частичных продаж (см. docs/02-data-model.md §4 и нюанс SBER).
 */

Decimal.set({ precision: 40 });

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
  /** накопленные дивиденды в рублях */
  dividendsRub: Decimal;
  /** накопленные купоны в рублях */
  couponsRub: Decimal;
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
export function calculatePositions(operations: Operation[]): PositionResult[] {
  const map = new Map<string, PositionResult>();

  // операции обрабатываем в хронологическом порядке
  const sorted = [...operations].sort((a, b) => a.date.localeCompare(b.date));

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
        dividendsRub: new Decimal(0),
        couponsRub: new Decimal(0),
      };
      map.set(key, pos);
    }

    const qty = d(op.quantity);
    const price = d(op.price);
    const fee = d(op.fee ?? '0');
    const fxRate = d(op.fxRate ?? '1');

    switch (op.operationType) {
      case 'Buy': {
        const cost = qty.mul(price).plus(fee);
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

/** Нереализованный P&L позиции по текущей цене (в валюте инструмента) */
export function unrealizedPnl(pos: PositionResult, currentPrice: Decimal): Decimal {
  const currentValue = pos.quantity.mul(currentPrice);
  return currentValue.minus(pos.investedCcy);
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
  openedAt: string;
  closedAt: string | null;
  /** id операций, из которых собрана сделка */
  operationIds: string[];
}

/**
 * Группирует операции одного инструмента (в рамках системы/портфеля) в сделки
 * (docs/02-data-model.md §2.5): сделка открывается первой покупкой и закрывается,
 * когда остаток уходит в ноль. Если позиция открывается заново после закрытия —
 * это уже новая сделка (реальный кейс: купил-продал-купил снова).
 */
export function calculateTrades(operations: Operation[]): TradeResult[] {
  const closed: TradeResult[] = [];
  const open = new Map<string, TradeResult>();

  const sorted = [...operations].sort((a, b) => a.date.localeCompare(b.date));

  for (const op of sorted) {
    if (!op.instrumentId) continue;
    if (op.operationType === 'Transfer') continue;

    const key = positionKey(op);
    const qty = d(op.quantity);
    const price = d(op.price);
    const fee = d(op.fee ?? '0');
    const fxRate = d(op.fxRate ?? '1');

    if (op.operationType === 'Buy') {
      let trade = open.get(key);
      if (!trade) {
        trade = {
          instrumentId: op.instrumentId,
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
          openedAt: op.date,
          closedAt: null,
          operationIds: [],
        };
        open.set(key, trade);
      }
      const cost = qty.mul(price).plus(fee);
      trade.investedCcy = trade.investedCcy.plus(cost);
      trade.investedRub = trade.investedRub.plus(cost.mul(fxRate));
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
      trade.proceedsCcy = trade.proceedsCcy.plus(proceeds);
      trade.proceedsRub = trade.proceedsRub.plus(proceeds.mul(fxRate));
      trade.investedCcy = trade.investedCcy.minus(costOfSold);
      trade.investedRub = trade.investedRub.minus(costOfSold.mul(fxRate));
      trade.quantity = trade.quantity.minus(qty);
      trade.qtySold = trade.qtySold.plus(qty);
      if (op.id) trade.operationIds.push(op.id);

      if (trade.quantity.lte(0)) {
        trade.quantity = new Decimal(0);
        trade.investedCcy = new Decimal(0);
        trade.investedRub = new Decimal(0);
        trade.status = 'Closed';
        trade.closedAt = op.date;
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
      if (op.id) trade.operationIds.push(op.id);
    }
  }

  return [...closed, ...open.values()];
}
