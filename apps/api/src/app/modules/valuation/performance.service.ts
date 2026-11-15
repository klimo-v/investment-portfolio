import Decimal from 'decimal.js';
import { Inject, Injectable } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  journalCompleteness,
  rebaseToPeriod,
  NO_INSTRUMENT_GROUP,
  payoutsInPeriod,
  periodPerformance,
  PerformanceSchema,
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
    const till = this.valuation.cap(query.till);
    const systemId = query.scope === 'system' ? query.id : undefined;
    const portfolioId =
      query.scope === 'portfolio'
        ? query.id
        : query.scope === 'system'
          ? query.portfolioId
          : undefined;
    const contour: PerformanceContour = systemId ? 'positions' : 'wealth';

    const ops = this.operations.list();
    const filtered = { systemId, portfolioId };
    const payouts = (extra: { systemId?: string; portfolioId?: string }) =>
      payoutsInPeriod(ops, { from: query.from, till, ...extra });

    // Вход (догрузка истории цен, котировки, курсы) готовим ОДИН раз на все ряды запроса: сеть и ensure —
    // самое дорогое, а ряды по системам и счетам считаются из того же входа чистой функцией.
    // Ряд — всегда с начала журнала: `from` задаёт период расчёта, а не окно запроса.
    const inputs = await this.valuation.prepare(till);
    const series = (q: {
      groupBy: 'system' | 'portfolio' | 'instrument';
      systemId?: string;
      portfolioId?: string;
    }) => this.valuation.build(inputs, { ...q, till });
    const base = series({ groupBy: 'system', ...filtered });
    const total = periodPerformance(base, {
      from: query.from,
      contour,
      payoutsRub: payouts(filtered),
    });

    const systemNames = new Map(
      this.db
        .select()
        .from(systems)
        .all()
        .map((s) => [s.id, s.name]),
    );
    const portfolioNames = new Map(
      this.db
        .select()
        .from(portfolios)
        .all()
        .map((p) => [p.id, p.name]),
    );

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

    const portfolioKeys = series({ groupBy: 'portfolio', ...filtered }).groups.map((g) => g.key);
    const byPortfolio = [];
    for (const pid of portfolioKeys) {
      const pfSeries = series({ groupBy: 'system', systemId, portfolioId: pid });
      byPortfolio.push({
        id: pid,
        name: portfolioNames.get(pid) ?? pid,
        performance: periodPerformance(pfSeries, {
          from: query.from,
          contour,
          payoutsRub: payouts({ systemId, portfolioId: pid }),
        }),
      });
    }

    const tickers = new Map(
      this.db
        .select()
        .from(instruments)
        .all()
        .map((i) => [i.id, i.ticker]),
    );
    const instrumentSeries = series({ groupBy: 'instrument', ...filtered });
    const byInstrument = instrumentSeries.groups.map((g) => {
      const points = query.from ? rebaseToPeriod(g.points, query.from) : g.points;
      return {
        instrumentId: g.key === NO_INSTRUMENT_GROUP ? null : g.key,
        name: g.key === NO_INSTRUMENT_GROUP ? 'Без инструмента' : (tickers.get(g.key) ?? g.key),
        resultRub: points.at(-1)?.totalRub ?? '0.00',
        quality:
          periodPerformance(instrumentSeries, {
            from: query.from,
            contour: 'positions',
            groupKey: g.key,
          }).quality ?? [],
      };
    });
    // Different aggregation orders round group values to kopecks. Keep the displayed
    // breakdown additive to the canonical card; allocate the rounding residue to
    // the largest absolute row (stable input order breaks ties).
    const sum = byInstrument.reduce((s, r) => s.plus(r.resultRub), new Decimal(0));
    const residue = new Decimal(total.resultRub).minus(sum);
    if (residue.abs().gt(new Decimal('0.02').mul(byInstrument.length + base.groups.length))) {
      throw new Error('Instrument breakdown does not reconcile with period result');
    }
    const largest = byInstrument.reduce<(typeof byInstrument)[number] | undefined>(
      (a, b) => (!a || new Decimal(b.resultRub).abs().gt(new Decimal(a.resultRub).abs()) ? b : a),
      undefined,
    );
    if (largest && !residue.isZero())
      largest.resultRub = new Decimal(largest.resultRub).plus(residue).toFixed(2);
    const warnings = await this.completeness(
      ops,
      filtered,
      till,
      contour === 'wealth' ? base : null,
    );

    return PerformanceSchema.parse({
      scope: query.scope,
      id: query.id ?? null,
      from: query.from ?? null,
      till,
      total,
      bySystem,
      byPortfolio,
      byInstrument,
      warnings: warnings.map((w) => ({
        ...w,
        inPeriod: warningTouchesPeriod(w, query.from, till),
      })),
      carried: (total.quality ?? []).map((c) => ({
        ...c,
        ticker: tickers.get(c.instrumentId) ?? c.instrumentId,
      })),
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
    const tickers = new Map(
      this.db
        .select()
        .from(instruments)
        .all()
        .map((i) => [i.id, i.ticker]),
    );
    const dates = cashFrom?.groups[0]?.points.map((p) => p.date) ?? [];
    const cash = cashFrom
      ? cashFrom.cashRub.map((cashRub, i) => ({ date: dates[i], cashRub }))
      : undefined;
    return journalCompleteness({
      operations: scoped,
      schedules: this.coupons.list([...firstOpDate.keys()]),
      cash,
      tickers,
      futureIds: this.operations.futureIds(),
      today: till,
    });
  }
}
