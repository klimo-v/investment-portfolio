import { Injectable } from '@nestjs/common';
import {
  benchmarkInstrumentId,
  BENCHMARK_INDEXES,
  BenchmarkResponseSchema,
  indexSeries,
  MONEY_MARKET,
  rateIndexSeries,
  type BenchmarkObservation,
  type BenchmarkResponse,
  type BenchmarkSeriesDto,
} from '@core';
import type { HistoryTarget } from './price-history.provider';
import { PriceHistoryService } from './price-history.service';

const MONEY_MARKET_NOTE =
  'Накопление по фактической ставке RUSFAR (денежный рынок, % годовых): что дали бы те же деньги на овернайте.';

/**
 * Ориентиры для «Портфель против рынка». Ряды индексов и ставки хранятся в price_history
 * как `index:MCFTRR` и догружаются тем же PriceHistoryService.ensure, что и цены бумаг, —
 * отдельного пути за историей индекса больше нет. Сервис только собирает наблюдения, ряды на
 * базе 100 строит чистый код из @core (libs/core/benchmark.ts).
 */
@Injectable()
export class BenchmarkService {
  constructor(private readonly history: PriceHistoryService) {}

  async benchmark(secid: string, from: string, till: string): Promise<BenchmarkResponse> {
    const [index, rate] = await Promise.all([this.observations(secid, from, till), this.observations(MONEY_MARKET.secid, from, till)]);
    const option = BENCHMARK_INDEXES.find((b) => b.secid === secid);
    const indexPoints = indexSeries(index, from, till);
    const ratePoints = rateIndexSeries(rate, from, till);
    const line = (s: string, label: string, note: string, series: BenchmarkSeriesDto['series']): BenchmarkSeriesDto | null =>
      series.length > 1 ? { secid: s, label, note, series } : null;
    return BenchmarkResponseSchema.parse({
      index: line(secid, option?.label ?? secid, option?.note ?? '', indexPoints),
      moneyMarket: line(MONEY_MARKET.secid, MONEY_MARKET.label, MONEY_MARKET_NOTE, ratePoints),
    });
  }

  /** Наблюдения SECID за период (с догрузкой недостающего). До `from` захватываем неделю: база — закрытие «на дату или раньше» */
  private async observations(secid: string, from: string, till: string): Promise<BenchmarkObservation[]> {
    const id = benchmarkInstrumentId(secid);
    const target: HistoryTarget = { instrumentId: id, ticker: secid, kind: 'index', type: 'Index', currency: 'IDX', marketSource: 'moex' };
    const lead = new Date(Date.parse(from) - 10 * 86_400_000).toISOString().slice(0, 10);
    await this.history.ensure([target], lead, till);
    return this.history.list([id], lead, till).map((r) => ({ date: r.date, value: Number(r.price) }));
  }
}
