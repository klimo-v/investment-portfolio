import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  calculatePositions,
  calculateTrades,
  OperationSchema,
  OperationReassignSchema,
  type Operation,
  type Position,
  type DashboardSummary,
  type Trade,
} from '@core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { operations, instruments, systems, quotes, type OperationRow } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { QuotesService } from '../quotes/quotes.service';

/**
 * Сервис операций — бизнес-логика (GRASP: Controller тонкий, логика здесь).
 * Хранение — Drizzle + SQLite (Фаза 1, docs/04-roadmap.md).
 */
@Injectable()
export class OperationsService {
  constructor(
    @Inject(DB) private readonly db: BetterSQLite3Database,
    private readonly quotesService: QuotesService,
  ) {}

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

  /** Удалить операцию по id (безвозвратно — пересчёт позиций/сделок исключит её). */
  delete(id: string): void {
    this.db.delete(operations).where(eq(operations.id, id)).run();
  }

  /**
   * Переназначить операцию на другую систему и/или портфель (docs/04-roadmap.md §3.1) —
   * например, при разборе отчёта, где сделки лежат в разных системах/на разных счетах
   * брокера (обычный ↔ ИИС), а батч-разметки при импорте оказалось недостаточно.
   * Валидация через Zod (CLAUDE.md §8); существование id проверяет FK-констрейнт БД.
   */
  reassign(id: string, raw: unknown): void {
    const patch = OperationReassignSchema.parse(raw);
    this.db
      .update(operations)
      .set(patch)
      .where(eq(operations.id, id))
      .run();
  }

  /**
   * Позиции считает общий движок из libs/core (DRY: одна логика фронт+бэк),
   * затем обогащаем текущей ценой из кэша котировок и пересчётом стоимости/P&L в RUB.
   */
  async positions(): Promise<Position[]> {
    const ops = this.list();
    const instrumentRows = this.db.select().from(instruments).all();
    const quoteRows = this.db.select().from(quotes).all();
    const instrumentById = new Map(instrumentRows.map((i) => [i.id, i]));
    const quoteByInstrument = new Map(quoteRows.map((q) => [q.instrumentId, q]));

    const result: Position[] = [];
    for (const p of calculatePositions(ops)) {
      const instrument = instrumentById.get(p.instrumentId);
      const currency = instrument?.currency ?? 'RUB';
      const quote = quoteByInstrument.get(p.instrumentId);

      let currentPrice: string | null = null;
      let currentValueRub: string | null = null;
      let pnlRub: string | null = null;

      if (quote) {
        currentPrice = quote.price;
        // курс валюты инструмента к рублю (для валютных позиций)
        const fx = await this.quotesService.getFxRate(currency);
        const qty = Number(p.quantity);
        const valueCcy = qty * Number(quote.price);
        const valueRub = valueCcy * fx;
        currentValueRub = valueRub.toFixed(2);
        // P&L в рублях = текущая стоимость − вложено (в RUB) + дивиденды/купоны
        const pnl =
          valueRub - Number(p.investedRub) + Number(p.dividendsRub) + Number(p.couponsRub);
        pnlRub = pnl.toFixed(2);
      }

      result.push({
        instrumentId: p.instrumentId,
        ticker: instrument?.ticker ?? p.instrumentId,
        systemId: p.systemId,
        portfolioId: p.portfolioId,
        type: instrument?.type ?? 'Stock',
        currency,
        quantity: p.quantity.toString(),
        avgBuyPrice: p.avgBuyPrice.toFixed(2),
        investedCcy: p.investedCcy.toFixed(2),
        investedRub: p.investedRub.toFixed(2),
        dividendsRub: p.dividendsRub.toFixed(2),
        couponsRub: p.couponsRub.toFixed(2),
        currentPrice,
        currentValueRub,
        pnlRub,
      });
    }
    return result;
  }

  /**
   * Сделки собираются движком из операций (docs/02-data-model.md §2.5): сделка
   * открывается первой покупкой и закрывается, когда остаток уходит в ноль.
   * Открытые сделки обогащаем текущей ценой/P&L, как и позиции.
   */
  async trades(): Promise<Trade[]> {
    const ops = this.list();
    const instrumentRows = this.db.select().from(instruments).all();
    const quoteRows = this.db.select().from(quotes).all();
    const instrumentById = new Map(instrumentRows.map((i) => [i.id, i]));
    const quoteByInstrument = new Map(quoteRows.map((q) => [q.instrumentId, q]));

    const result: Trade[] = [];
    for (const t of calculateTrades(ops)) {
      const instrument = instrumentById.get(t.instrumentId);
      const currency = instrument?.currency ?? 'RUB';
      const quote = quoteByInstrument.get(t.instrumentId);

      let currentPrice: string | null = null;
      let currentValueRub: string | null = null;

      if (quote && t.quantity.gt(0)) {
        currentPrice = quote.price;
        const fx = await this.quotesService.getFxRate(currency);
        const valueRub = Number(t.quantity) * Number(quote.price) * fx;
        currentValueRub = valueRub.toFixed(2);
      }
      // P&L = реализованный (по проданной части) + нереализованный (по остатку) + выплаты
      const unrealizedRub = currentValueRub ? Number(currentValueRub) - Number(t.investedRub) : 0;
      const pnlRub = (
        Number(t.realizedPnlRub) +
        unrealizedRub +
        Number(t.dividendsRub) +
        Number(t.couponsRub)
      ).toFixed(2);

      result.push({
        id: t.operationIds[0],
        instrumentId: t.instrumentId,
        ticker: instrument?.ticker ?? t.instrumentId,
        systemId: t.systemId,
        portfolioId: t.portfolioId,
        type: instrument?.type ?? 'Stock',
        currency,
        status: t.status,
        quantity: t.quantity.toString(),
        qtyBought: t.qtyBought.toString(),
        qtySold: t.qtySold.toString(),
        avgBuyPrice: t.avgBuyPrice.toFixed(2),
        investedCcy: t.investedCcy.toFixed(2),
        investedRub: t.investedRub.toFixed(2),
        proceedsCcy: t.proceedsCcy.toFixed(2),
        proceedsRub: t.proceedsRub.toFixed(2),
        realizedPnlCcy: t.realizedPnlCcy.toFixed(2),
        realizedPnlRub: t.realizedPnlRub.toFixed(2),
        dividendsRub: t.dividendsRub.toFixed(2),
        couponsRub: t.couponsRub.toFixed(2),
        currentPrice,
        currentValueRub,
        pnlRub,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        operationIds: t.operationIds,
      });
    }
    return result;
  }

  /**
   * Агрегаты для дашборда (логика построения — из portfolio_dashboard.html):
   * помесячный поток/доход для комбо-графика, P&L по системам, breakdown по тикерам.
   */
  async summary(): Promise<DashboardSummary> {
    const ops = this.list();
    const positions = await this.positions();
    const systemRows = this.db.select().from(systems).all();
    const systemName = new Map(systemRows.map((s) => [s.id, s.name]));

    // временной ряд по месяцам: поток кэша и доход (дивиденды/купоны)
    const monthly = new Map<string, { flow: number; income: number }>();
    for (const op of ops) {
      const period = op.date.slice(0, 7); // YYYY-MM
      const bucket = monthly.get(period) ?? { flow: 0, income: 0 };
      const amount = Number(op.quantity) * Number(op.price) * Number(op.fxRate);
      if (op.operationType === 'Deposit') bucket.flow += amount;
      else if (op.operationType === 'Withdraw') bucket.flow -= amount;
      else if (op.operationType === 'Dividend' || op.operationType === 'Coupon')
        bucket.income += amount;
      monthly.set(period, bucket);
    }
    const timeline = [...monthly.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([period, v]) => ({ period, flow: v.flow, income: v.income }));

    // P&L по системам
    const systemAgg = new Map<string, { investedRub: number; pnlRub: number }>();
    for (const p of positions) {
      const agg = systemAgg.get(p.systemId) ?? { investedRub: 0, pnlRub: 0 };
      agg.investedRub += Number(p.investedRub);
      agg.pnlRub += Number(p.pnlRub ?? 0);
      systemAgg.set(p.systemId, agg);
    }
    const bySystem = [...systemAgg.entries()].map(([systemId, v]) => ({
      systemId,
      name: systemName.get(systemId) ?? systemId,
      investedRub: v.investedRub,
      pnlRub: v.pnlRub,
    }));

    // breakdown прибыль/убыток по инструментам (сортировка по величине P&L)
    const breakdown = positions
      .filter((p) => p.pnlRub !== null)
      .map((p) => ({ ticker: p.ticker, pnlRub: Number(p.pnlRub) }))
      .sort((a, b) => b.pnlRub - a.pnlRub);

    const totals = {
      investedRub: positions.reduce((s, p) => s + Number(p.investedRub), 0),
      currentValueRub: positions.reduce((s, p) => s + Number(p.currentValueRub ?? 0), 0),
      pnlRub: positions.reduce((s, p) => s + Number(p.pnlRub ?? 0), 0),
      dividendsRub: positions.reduce((s, p) => s + Number(p.dividendsRub) + Number(p.couponsRub), 0),
    };

    return { timeline, bySystem, breakdown, totals };
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
