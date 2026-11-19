import Decimal from 'decimal.js';
import type { Operation } from './schemas';

/** Сумма спотовой сделки до комиссии, в валюте операции. */
export function grossTradeAmount(op: Operation): Decimal {
  return (op.operationType === 'Buy' || op.operationType === 'Sell') && op.grossTradeAmount != null
    ? new Decimal(op.grossTradeAmount)
    : new Decimal(op.quantity).mul(op.price);
}
