import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Decimal from 'decimal.js';
import {
  SystemPerformanceSchema,
  systemPerformance,
  type SystemPerformance,
  type SystemPerformanceQuery,
  type TradeResult,
} from '@core';
import { systems } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { OperationsService } from '../operations/operations.service';

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

    const body = systemPerformance(
      valued.map((v) => v.trade),
      { unrealizedOf: (t) => unrealized.get(t) ?? null },
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
}
