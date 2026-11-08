import { Inject, Injectable } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { cashSeries, fxInstrumentId, isFxInstrumentId, NO_INSTRUMENT_GROUP, ValuationSeriesSchema, valuationEvents, valuationSeries, type Operation, type PriceObservation, type ValuationQuery, type ValuationSeriesDto } from '@core';
import { instruments, portfolios, quotes, systems } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { OperationsService } from '../operations/operations.service';
import { PriceHistoryService } from '../quotes/price-history.service';
import { QuotesService } from '../quotes/quotes.service';

/** Подготовленный вход расчёта рядов (см. ValuationService.prepare) */
export interface SeriesInputs {
  till: string;
  ops: Operation[];
  observations: PriceObservation[];
  /** по фильтру нет ни одной сделки — ряда нет */
  empty: boolean;
}

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

  /** Ряд оценки под запрос: подготовка входа (сеть, история цен) + чистый расчёт */
  async series(query: ValuationQuery): Promise<ValuationSeriesDto> {
    const till = this.cap(query.till);
    const inputs = await this.prepare(till, { systemId: query.systemId, portfolioId: query.portfolioId });
    return this.build(inputs, query);
  }

  /** Конец периода: не позже сегодня */
  cap(till: string | undefined): string {
    const today = new Date().toISOString().slice(0, 10);
    return till && till < today ? till : today;
  }

  /**
   * Вход расчёта рядов: журнал (под фильтр), история цен с догрузкой недостающего, сегодняшние
   * котировки и курсы. Вынесено из series(), чтобы расчёт с несколькими рядами (доходность по
   * системам и счетам) готовил вход ОДИН раз: догрузка истории и сетевые курсы — самое дорогое.
   */
  async prepare(till: string, filter: { systemId?: string; portfolioId?: string } = {}): Promise<SeriesInputs> {
    const today = new Date().toISOString().slice(0, 10);
    const ops = this.operations
      .list()
      .filter(
        (o) =>
          (!filter.systemId || o.systemId === filter.systemId) &&
          (!filter.portfolioId || o.portfolioId === filter.portfolioId),
      );
    const traded = ops.filter((o) => o.instrumentId && o.operationType !== 'Transfer' && o.date <= till);
    if (traded.length === 0) return { till, ops, observations: [], empty: true };

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

    return { till, ops, observations, empty: false };
  }

  /** Чистая сборка DTO из подготовленного входа под запрос (без сети); фильтры системы/портфеля — из запроса */
  build(inputs: SeriesInputs, query: ValuationQuery): ValuationSeriesDto {
    const { till, ops, observations } = inputs;
    if (inputs.empty) {
      return ValuationSeriesSchema.parse({ from: query.from ?? null, till, groupBy: query.groupBy, groups: [], netContributionsRub: [] });
    }
    const futureIds = this.operations.futureIds();
    const result = valuationSeries(ops, observations, {
      till,
      from: query.from,
      groupBy: query.groupBy,
      systemId: query.systemId,
      portfolioId: query.portfolioId,
      futureIds,
    });

    const names = this.nameOf(query.groupBy);
    // кэш осмыслен только у контура со своим кэшем — без фильтра по системе (см. valuation-extras.ts)
    const hasCash = !query.systemId;
    const tickers = this.nameOf('instrument');
    const events = valuationEvents(ops, {
      from: result.from ?? undefined,
      till,
      systemId: query.systemId,
      portfolioId: query.portfolioId,
      futureIds,
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
