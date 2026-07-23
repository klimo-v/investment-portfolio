import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { calculatePositions, OperationSchema, type Operation, type Position } from '@core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { operations, instruments, type OperationRow } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';

/**
 * Сервис операций — бизнес-логика (GRASP: Controller тонкий, логика здесь).
 * Хранение — Drizzle + SQLite (Фаза 1, docs/04-roadmap.md).
 */
@Injectable()
export class OperationsService {
  constructor(@Inject(DB) private readonly db: BetterSQLite3Database) {}

  list(): Operation[] {
    const rows = this.db.select().from(operations).all();
    return rows.map(rowToOperation);
  }

  /** Валидация тела через Zod (CLAUDE.md §8 — не доверяем клиенту), затем запись в БД */
  add(raw: unknown): Operation {
    const parsed = OperationSchema.parse(raw);
    const id = parsed.id ?? randomUUID();

    this.db
      .insert(operations)
      .values({
        id,
        date: parsed.date,
        systemId: parsed.systemId,
        portfolioId: parsed.portfolioId,
        instrumentId: parsed.instrumentId ?? null,
        operationType: parsed.operationType,
        quantity: parsed.quantity,
        price: parsed.price,
        fee: parsed.fee ?? '0',
        fxRate: parsed.fxRate ?? '1',
        currency: parsed.currency,
        transferGroup: parsed.transferGroup ?? null,
        tradeId: parsed.tradeId ?? null,
        note: parsed.note ?? null,
        brokerRef: parsed.brokerRef ?? null,
        importBatchId: parsed.importBatchId ?? null,
      })
      .run();

    return { ...parsed, id };
  }

  /** Позиции считает общий движок из libs/core (DRY: одна логика фронт+бэк) */
  positions(): Position[] {
    const ops = this.list();
    const instrumentRows = this.db.select().from(instruments).all();
    const tickerById = new Map(instrumentRows.map((i) => [i.id, i]));

    return calculatePositions(ops).map((p) => {
      const instrument = tickerById.get(p.instrumentId);
      return {
        instrumentId: p.instrumentId,
        ticker: instrument?.ticker ?? p.instrumentId,
        systemId: p.systemId,
        portfolioId: p.portfolioId,
        type: instrument?.type ?? 'Stock',
        currency: instrument?.currency ?? 'RUB',
        quantity: p.quantity.toString(),
        avgBuyPrice: p.avgBuyPrice.toFixed(2),
        investedCcy: p.investedCcy.toFixed(2),
        investedRub: p.investedRub.toFixed(2),
        dividendsRub: p.dividendsRub.toFixed(2),
        couponsRub: p.couponsRub.toFixed(2),
        currentPrice: null,
        currentValueRub: null,
        pnlRub: null,
      };
    });
  }
}

function rowToOperation(row: OperationRow): Operation {
  return {
    id: row.id,
    date: row.date,
    systemId: row.systemId,
    portfolioId: row.portfolioId,
    instrumentId: row.instrumentId,
    operationType: row.operationType as Operation['operationType'],
    quantity: row.quantity,
    price: row.price,
    fee: row.fee,
    fxRate: row.fxRate,
    currency: row.currency,
    transferGroup: row.transferGroup,
    tradeId: row.tradeId,
    note: row.note ?? undefined,
    brokerRef: row.brokerRef ?? undefined,
    importBatchId: row.importBatchId,
  };
}
