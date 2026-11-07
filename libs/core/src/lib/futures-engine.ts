import Decimal from 'decimal.js';

/**
 * Общая ветка учёта срочных контрактов (фьючерсов) для движка (engine.ts, cash.ts).
 * Вынесена в одно место, чтобы три копии обхода журнала в движке не расходились (DRY).
 *
 * Модель — «способ А»: результат считается по цене сделок, умноженной на множитель
 * серии (цена в операции уже в ₽ за контракт, см. futures.ts). Вариационная маржа из
 * отчёта брокера в расчёт не входит — иначе двойной учёт.
 *  - позиция со знаком: лонг > 0, шорт < 0;
 *  - средняя цена входа по открытой части;
 *  - закрытие/уменьшение: (цена − средняя) × кол-во × знак позиции;
 *  - комиссия вычитается из реализованного результата в момент каждой сделки
 *    (учитывается ровно один раз и видна у открытой позиции);
 *  - «вложено» у фьючерса всегда 0 (гарантийное обеспечение — не вложение).
 */

/** Изменяемая часть позиции, которую двигает сделка */
export interface FuturePosition {
  /** количество со знаком: шорт < 0 */
  quantity: Decimal;
  /** средняя цена входа открытой части (0 при нулевой позиции) */
  avgBuyPrice: Decimal;
}

export interface FutureFill {
  /** сколько контрактов сделка закрыла в существующей позиции */
  closedQty: Decimal;
  /** сколько контрактов открыла (новая позиция или переворот) */
  openedQty: Decimal;
  /** результат закрытой части по цене, в валюте сделки, без комиссии */
  pnlCcy: Decimal;
  /** комиссия сделки целиком, в валюте сделки */
  feeCcy: Decimal;
}

/**
 * Применяет сделку к позиции (мутирует `pos`) и возвращает разбор: сколько закрыто,
 * сколько открыто и результат закрытой части. Переворот через ноль (лонг → шорт)
 * разбирается на закрытие + открытие остатка по цене сделки.
 */
export function applyFutureFill(
  pos: FuturePosition,
  side: 'Buy' | 'Sell',
  qty: Decimal,
  price: Decimal,
  fee: Decimal,
): FutureFill {
  // нулевое количество — шум в данных: не двигаем позицию (иначе деление на ноль → NaN
  // в средней цене) и не начисляем комиссию за несостоявшуюся сделку
  if (qty.isZero()) {
    return {
      closedQty: new Decimal(0),
      openedQty: new Decimal(0),
      pnlCcy: new Decimal(0),
      feeCcy: new Decimal(0),
    };
  }
  const signed = side === 'Buy' ? qty : qty.neg();
  const sameDirection = pos.quantity.isZero() || pos.quantity.isPositive() === signed.isPositive();

  if (sameDirection) {
    const absOld = pos.quantity.abs();
    const absNew = absOld.plus(qty);
    pos.avgBuyPrice = absOld.mul(pos.avgBuyPrice).plus(qty.mul(price)).div(absNew);
    pos.quantity = pos.quantity.plus(signed);
    return { closedQty: new Decimal(0), openedQty: qty, pnlCcy: new Decimal(0), feeCcy: fee };
  }

  const direction = pos.quantity.isPositive() ? 1 : -1;
  const closedQty = Decimal.min(qty, pos.quantity.abs());
  const pnlCcy = price.minus(pos.avgBuyPrice).mul(closedQty).mul(direction);
  const openedQty = qty.minus(closedQty);
  pos.quantity = pos.quantity.plus(signed);
  if (pos.quantity.isZero()) pos.avgBuyPrice = new Decimal(0);
  else if (openedQty.gt(0)) pos.avgBuyPrice = price; // переворот: новая позиция по цене сделки
  return { closedQty, openedQty, pnlCcy, feeCcy: fee };
}

/**
 * Нереализованный результат по расчётной цене: (расчётная − средняя) × кол-во со знаком.
 * Для шорта (кол-во < 0) рост цены даёт убыток.
 */
export function futureUnrealizedPnl(pos: FuturePosition, markPrice: Decimal.Value): Decimal {
  return new Decimal(markPrice).minus(pos.avgBuyPrice).mul(pos.quantity);
}
