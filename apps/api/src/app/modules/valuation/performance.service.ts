import { Inject, Injectable } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  cashSeries,
  journalCompleteness,
  payoutsInPeriod,
  periodPerformance,
  PerformanceSchema,
  type CarriedPrice,
  type PerformanceContour,
  type PerformanceDto,
  type PerformanceQuery,
  warningTouchesPeriod,
  type ValuationSeriesDto,
} from '@core';
import { instruments, portfolios, systems } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { OperationsService } from '../operations/operations.service';
import { CouponScheduleService } from '../quotes/coupon-schedule.service';
import { ValuationService } from './valuation.service';

/**
 * Единый расчёт доходности за период (libs/core/period-performance.ts). Сервис только собирает
 * вход — полный дневной ряд (с первой операции, чтобы нашлась база периода — день до `from`) и
 * журнал для разбивки выплат — а все цифры (карточки, «Портфель против рынка», таблица
 * эффективности) берутся из одного DTO. Ничего не пересчитывается на фронте.
 *
 * Контур: весь журнал или один портфель — `wealth` (позиции + кэш, свой кэш есть);
 * система — `positions` (своего кэша нет).
 */
@Injectable()
export class PerformanceService {
  constructor(
    @Inject(DB) private readonly db: BetterSQLite3Database,
    private readonly valuation: ValuationService,
    private readonly operations: OperationsService,
    private readonly coupons: CouponScheduleService,
  ) {}

  async performance(query: PerformanceQuery): Promise<PerformanceDto> {
    const today = new Date().toISOString().slice(0, 10);
    const till = query.till && query.till < today ? query.till : today;
    const systemId = query.scope === 'system' ? query.id : undefined;
    const portfolioId = query.scope === 'portfolio' ? query.id : query.scope === 'system' ? query.portfolioId : undefined;
    const contour: PerformanceContour = systemId ? 'positions' : 'wealth';

    const ops = this.operations.list();
    const filtered = { systemId, portfolioId };
    const payouts = (extra: { systemId?: string; portfolioId?: string }) =>
      payoutsInPeriod(ops, { from: query.from, till, ...extra });

    // ряд — всегда с начала журнала: `from` задаёт период расчёта, а не окно запроса
    const base = await this.valuation.series({ groupBy: 'system', ...filtered, till });
    const total = periodPerformance(base, { from: query.from, contour, payoutsRub: payouts(filtered) });

    const systemNames = new Map(this.db.select().from(systems).all().map((s) => [s.id, s.name]));
    const portfolioNames = new Map(this.db.select().from(portfolios).all().map((p) => [p.id, p.name]));

    const bySystem = base.groups.map((g) => ({
      id: g.key,
      name: systemNames.get(g.key) ?? g.key,
      performance: periodPerformance(base, {
        from: query.from,
        contour: 'positions',
        groupKey: g.key,
        payoutsRub: payouts({ systemId: g.key, portfolioId }),
      }),
    }));

    const portfolioKeys = (await this.valuation.series({ groupBy: 'portfolio', ...filtered, till })).groups.map((g) => g.key);
    const byPortfolio = [];
    for (const pid of portfolioKeys) {
      const series = await this.valuation.series({ groupBy: 'system', systemId, portfolioId: pid, till });
      byPortfolio.push({
        id: pid,
        name: portfolioNames.get(pid) ?? pid,
        performance: periodPerformance(series, {
          from: query.from,
          contour,
          payoutsRub: payouts({ systemId, portfolioId: pid }),
        }),
      });
    }

    const warnings = await this.completeness(ops, filtered, till, contour === 'wealth' ? base : null);

    return PerformanceSchema.parse({
      scope: query.scope,
      id: query.id ?? null,
      from: query.from ?? null,
      till,
      total,
      bySystem,
      byPortfolio,
      warnings: warnings.map((w) => ({ ...w, inPeriod: warningTouchesPeriod(w, query.from, till) })),
      carried: carriedAtEnd(base),
    });
  }

  /**
   * Полнота журнала для выбранного среза: купоны по графику биржи (график грузится и кэшируется
   * в БД) и вычисленный кэш (только у контура со своим кэшем — `cashFrom` не null).
   */
  private async completeness(
    ops: ReturnType<OperationsService['list']>,
    filter: { systemId?: string; portfolioId?: string },
    till: string,
    cashFrom: ValuationSeriesDto | null,
  ) {
    const scoped = ops.filter(
      (o) =>
        o.date <= till &&
        (!filter.systemId || o.systemId === filter.systemId) &&
        (!filter.portfolioId || o.portfolioId === filter.portfolioId),
    );
    const firstOpDate = new Map<string, string>();
    for (const o of scoped) {
      if (!o.instrumentId || (o.operationType !== 'Buy' && o.operationType !== 'Sell')) continue;
      const known = firstOpDate.get(o.instrumentId);
      if (known === undefined || o.date < known) firstOpDate.set(o.instrumentId, o.date);
    }
    await this.coupons.ensure(firstOpDate, till);
    const tickers = new Map(this.db.select().from(instruments).all().map((i) => [i.id, i.ticker]));
    const dates = cashFrom?.groups[0]?.points.map((p) => p.date) ?? [];
    const cash = cashFrom ? cashSeries(cashFrom).map((cashRub, i) => ({ date: dates[i], cashRub })) : undefined;
    return journalCompleteness({
      operations: scoped,
      schedules: this.coupons.list([...firstOpDate.keys()]),
      cash,
      tickers,
      today: till,
    });
  }
}

/** Пометки «цена не за день» на последний день ряда — по ним карточка помечается как неточная */
function carriedAtEnd(series: ValuationSeriesDto): CarriedPrice[] {
  const seen = new Map<string, CarriedPrice>();
  for (const g of series.groups) {
    const last = g.points[g.points.length - 1];
    for (const c of last?.carried ?? []) if (!seen.has(c.instrumentId)) seen.set(c.instrumentId, c);
  }
  return [...seen.values()];
}
