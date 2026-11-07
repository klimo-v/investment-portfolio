import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Decimal from 'decimal.js';
import {
  SystemPerformanceSchema,
  systemPerformance,
  type ExecutionFill,
  type SystemPerformance,
  type SystemPerformanceQuery,
  type TradeResult,
} from '@core';
import { operationAnnotations, operations, systems } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { OperationsService } from '../operations/operations.service';
import { ValuationService } from '../valuation/valuation.service';

/**
 * Статистика торговой системы. Сервис только собирает вход: сделки и их оценку берёт
 * у OperationsService (единая сборка сделок и оценка по котировкам, без дубля загрузки
 * журнала и набора futureIds), а математика — чистая функция systemPerformance из @core.
 */
@Injectable()
export class SystemPerformanceService {
  constructor(
    @Inject(DB) private readonly db: BetterSQLite3Database,
    private readonly operations: OperationsService,
    private readonly valuation: ValuationService,
  ) {}

  /** @throws NotFoundException если системы нет в справочнике */
  async performance(systemId: string, query: SystemPerformanceQuery): Promise<SystemPerformance> {
    const [system] = this.db.select().from(systems).where(eq(systems.id, systemId)).all();
    if (!system) throw new NotFoundException(`Система «${systemId}» не найдена`);

    const valued = await this.operations.valuedTrades({ systemId, ...query });
    // нереализованный результат = рыночная стоимость остатка − себестоимость остатка
    // (у фьючерса себестоимость 0, а «стоимость» — уже нереализованный результат)
    const unrealized = new Map<TradeResult, Decimal>(
      valued
        .filter((v) => v.currentValueRub !== null)
        .map((v) => [v.trade, new Decimal(v.currentValueRub as string).minus(v.trade.investedRub)]),
    );

    // дневная кривая той же системы и того же среза — из единого valuationSeries
    const curve = await this.valuation.series({
      groupBy: 'system',
      systemId,
      portfolioId: query.portfolioId,
      from: query.from,
      till: query.till,
    });
    const daily = curve.groups.find((g) => g.key === systemId)?.points ?? [];
    const body = systemPerformance(
      valued.map((v) => v.trade),
      { unrealizedOf: (t) => unrealized.get(t) ?? null, daily, fills: this.executionFills(valued.map((v) => v.trade)) },
    );
    // ВМ брокера привязана к счёту и инструменту, а не к системе: показываем сверку
    // только там, где весь инструмент в портфеле принадлежит этой системе
    const reconciliation = [...this.operations.settlementChecks().values()]
      .filter(
        (c) =>
          c.systemIds.size === 1 &&
          c.systemIds.has(systemId) &&
          (!query.portfolioId || c.portfolioId === query.portfolioId),
      )
      .map(({ systemIds: _systemIds, ...check }) => check);

    return SystemPerformanceSchema.parse({ systemId, systemName: system.name, ...body, reconciliation });
  }

  /** Аннотации исполнения операций этих сделок: тег и сигнальная цена (необязательное обогащение) */
  private executionFills(trades: readonly TradeResult[]): ExecutionFill[] {
    const ids = new Set(trades.flatMap((t) => t.operationIds));
    if (ids.size === 0) return [];
    const ops = new Map(
      this.db.select().from(operations).all().filter((o) => ids.has(o.id)).map((o) => [o.id, o]),
    );
    return this.db
      .select()
      .from(operationAnnotations)
      .all()
      .flatMap((a): ExecutionFill[] => {
        const op = ops.get(a.operationId);
        if (!op || (op.operationType !== 'Buy' && op.operationType !== 'Sell')) return [];
        return [
          {
            operationId: a.operationId,
            tag: a.tag,
            side: op.operationType,
            quantity: new Decimal(op.quantity),
            price: new Decimal(op.price),
            signalPrice: a.signalPrice ? new Decimal(a.signalPrice) : null,
          },
        ];
      });
  }
}
