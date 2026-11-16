import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Decimal from 'decimal.js';
import {
  isStandaloneCost,
  payoutsInPeriod,
  incomeAmountRub,
  isUnattributedIncome,
  rebaseToPeriod,
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

    const till = this.valuation.cap(query.till);
    const scope = { systemId, portfolioId: query.portfolioId };
    const inputs = await this.valuation.prepare(till, scope);
    const curve = this.valuation.build(inputs, { ...scope, groupBy: 'system', till });
    const valued = await this.operations.valuedTrades({ ...scope, from: query.from, till }, true);
    // нереализованный результат = рыночная стоимость остатка − себестоимость остатка
    // (у фьючерса себестоимость 0, а «стоимость» — уже нереализованный результат)
    const unrealized = new Map<TradeResult, Decimal>(
      valued
        .filter((v) => v.currentValueRub !== null)
        .map((v) => [v.trade, new Decimal(v.currentValueRub as string).minus(v.trade.investedRub)]),
    );

    const full = curve.groups.find((g) => g.key === systemId)?.points ?? [];
    // фильтр периода: кривая — результат ЗА период (от нуля на день до `from`), а не накопленный
    // с начала истории; метрики кривой (просадка, Sharpe) считаются по этому окну
    const daily = query.from ? rebaseToPeriod(full, query.from) : full;
    // выплаты без инструмента: к сделкам не относятся, но в сводке дашборда они есть
    const periodOps = inputs.ops.filter(o => o.date <= till && (!query.from || o.date >= query.from));
    const futureIds = this.operations.futureIds();
    // rebaseToPeriod возвращает хвост полного ряда, начальная оценка — предыдущая точка.
    const base = daily.length ? full[full.length - daily.length - 1] : undefined;
    const trades = valued.map(v => v.trade);
    const body = systemPerformance(trades, {
      daily,
      base,
      periodIncomeRub: payoutsInPeriod(periodOps, { till }),
      hasCashActivity: periodOps.some(o =>
        o.operationType === 'Dividend' || o.operationType === 'Coupon' || isStandaloneCost(o, futureIds)),
      unattributedIncomeRub: periodOps.filter(isUnattributedIncome)
        .reduce((sum, o) => sum.plus(incomeAmountRub(o)), new Decimal(0)),
      unrealizedOf: t => unrealized.get(t) ?? null,
      fills: this.executionFills(trades),
    });
    // ВМ брокера привязана к счёту и инструменту, а не к системе: показываем сверку
    // только там, где весь инструмент в портфеле принадлежит этой системе
    const reconciliation = [...this.operations.settlementChecks().values()]
      .filter(
        (c) =>
          c.asOf <= till &&
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
