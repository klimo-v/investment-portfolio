import type { Operation } from '@core';
import type { OperationRow } from './schema';

export function rowToOperation(row: OperationRow): Operation {
  return {
    id: row.id,
    date: row.date,
    systemId: row.systemId,
    portfolioId: row.portfolioId,
    instrumentId: row.instrumentId,
    operationType: row.operationType,
    quantity: row.quantity,
    price: row.price,
    fee: row.fee,
    grossTradeAmount: row.grossTradeAmount,
    grossTradeAmountSource: row.grossTradeAmountSource,
    fxRate: row.fxRate,
    currency: row.currency,
    transferGroup: row.transferGroup,
    tradeId: row.tradeId,
    note: row.note ?? undefined,
    brokerRef: row.brokerRef ?? undefined,
    executedAt: row.executedAt,
    importBatchId: row.importBatchId,
  };
}
