import { Inject, Injectable } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { cashSeries, fxInstrumentId, isFxInstrumentId, NO_INSTRUMENT_GROUP, ValuationSeriesSchema, valuationEvents, valuationSeries, type PriceObservation, type ValuationQuery, type ValuationSeriesDto } from '@core';
import { instruments, portfolios, quotes, systems } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { OperationsService } from '../operations/operations.service';
import { PriceHistoryService } from '../quotes/price-history.service';
import { QuotesService } from '../quotes/quotes.service';

/**
 * Сервис дневных рядов оценки. Только собирает вход — журнал, историю цен (с догрузкой
 * недостающего), сегодняшние котировки и курсы — а арифметика целиком в чистой функции
 * valuationSeries из @core. Результат нигде не хранится: правка журнала или цен учитывается
 * при следующем запросе сама собой.
 */
@Injectable()
export class ValuationService {
  constructor(
    @Inject(DB) private readonly db: BetterSQLite3Database,
    private readonly operations: OperationsService,
    private readonly priceHistory: PriceHistoryService,
    private readonly quotesService: QuotesService,
  ) {}

  async series(query: ValuationQuery): Promise<ValuationSeriesDto> {
    const today = new Date().toISOString().slice(0, 10);
    const till = query.till && query.till < today ? query.till : today;

    const ops = this.operations
      .list()
      .filter(
        (o) =>
          (!query.systemId || o.systemId === query.systemId) &&
          (!query.portfolioId || o.portfolioId === query.portfolioId),
      );
    const traded = ops.filter((o) => o.instrumentId && o.operationType !== 'Transfer' && o.date <= till);
    if (traded.length === 0) {
      return ValuationSeriesSchema.parse({ from: query.from ?? null, till, groupBy: query.groupBy, groups: [], netContributionsRub: [] });
    }

    const instrumentIds = [...new Set(traded.map((o) => o.instrumentId as string))];
    // начало загрузки — своё у каждой бумаги: дата её первой операции
    const firstOpDate = new Map<string, string>();
    for (const o of traded) {
      const id = o.instrumentId as string;
      const known = firstOpDate.get(id);
      if (known === undefined || o.date < known) firstOpDate.set(id, o.date);
    }
    await this.priceHistory.ensureForInstruments(firstOpDate, till);

    // история + текущие котировки и курсы как наблюдения: так итог ряда совпадает с текущей
    // сводкой, даже если «Обновить цены» сегодня ещё не нажимали. Котировка ставится на СВОЮ
    // дату (asOf, не позже till), а не на till: устаревшая котировка (например, расчётная цена
    // фьючерса из отчёта брокера трёхдневной давности) не должна перебивать более свежую
    // историю и рисовать скачок в последний день. Добавляются ПОСЛЕ истории — при равной
    // дате побеждает последняя.
    const targets = this.priceHistory.targetsFor(instrumentIds);
    const observations: PriceObservation[] = this.priceHistory
      .list(targets.map((t) => t.instrumentId), undefined, till)
      .map((r) => ({
        instrumentId: r.instrumentId,
        date: r.date,
        price: r.price,
        currency: r.currency,
        accruedInterest: r.accruedInterest,
        accruedCurrency: r.accruedCurrency,
      }));
    if (till === today) {
      const ids = new Set(instrumentIds);
      for (const q of this.db.select().from(quotes).all()) {
        if (!ids.has(q.instrumentId)) continue;
        observations.push({
          instrumentId: q.instrumentId,
          date: q.asOf.slice(0, 10) < till ? q.asOf.slice(0, 10) : till,
          price: q.price,
          currency: q.currency,
          accruedInterest: q.accruedInterest,
          accruedCurrency: q.accruedCurrency,
        });
      }
      for (const t of targets.filter((x) => isFxInstrumentId(x.instrumentId))) {
        const rate = await this.quotesService.getFxRateOrNull(t.ticker);
        if (rate !== null) {
          observations.push({ instrumentId: fxInstrumentId(t.ticker), date: till, price: String(rate), currency: 'RUB' });
        }
      }
    }

    const result = valuationSeries(ops, observations, {
      till,
      from: query.from,
      groupBy: query.groupBy,
      futureIds: this.operations.futureIds(),
    });

    const names = this.nameOf(query.groupBy);
    // кэш осмыслен только у контура со своим кэшем — без фильтра по системе (см. valuation-extras.ts)
    const hasCash = !query.systemId;
    const tickers = this.nameOf('instrument');
    const events = valuationEvents(ops, {
      from: result.from ?? undefined,
      till,
      futureIds: this.operations.futureIds(),
    }).map((e) => ({ ...e, name: e.instrumentId ? (tickers.get(e.instrumentId) ?? e.instrumentId) : (tickers.get(NO_INSTRUMENT_GROUP) ?? '') }));
    return ValuationSeriesSchema.parse({
      ...result,
      groups: result.groups.map((g) => ({ ...g, name: names.get(g.key) ?? g.key })),
      hasCash,
      cashRub: hasCash ? cashSeries(result) : [],
      events,
    });
  }

  private nameOf(groupBy: ValuationQuery['groupBy']): Map<string, string> {
    if (groupBy === 'system') return new Map(this.db.select().from(systems).all().map((s) => [s.id, s.name]));
    if (groupBy === 'portfolio') return new Map(this.db.select().from(portfolios).all().map((p) => [p.id, p.name]));
    return new Map([
      ...this.db.select().from(instruments).all().map((i): [string, string] => [i.id, i.ticker]),
      [NO_INSTRUMENT_GROUP, 'Без инструмента'],
    ]);
  }
}
