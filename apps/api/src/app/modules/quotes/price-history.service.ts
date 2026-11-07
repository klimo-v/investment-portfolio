import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { fxInstrumentId, isMarketSource, type PriceSource } from '@core';
import { recordPrice } from '../../../db/price-history-store';
import { instruments, priceHistory, quotes, type PriceHistoryRow } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import {
  PRICE_HISTORY_PROVIDERS,
  type HistoryPoint,
  type HistoryTarget,
  type PriceHistoryProvider,
} from './price-history.provider';

/** Как долго не повторяем запрос к источнику, который ничего не вернул или упал */
const NEGATIVE_TTL_MS = 60 * 60 * 1000;

const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * История цен: хранение, политика конфликтов источников и догрузка по требованию.
 *
 * Хранилище — только факты (цены дня). Готовых рядов стоимости здесь нет: их считает
 * чистая функция valuationSeries из @core, поэтому инвалидировать нечего.
 */
@Injectable()
export class PriceHistoryService {
  private readonly log = new Logger(PriceHistoryService.name);
  /** instrumentId → когда источник последний раз не дал данных (в памяти, не в БД) */
  private readonly failedAt = new Map<string, number>();

  constructor(
    @Inject(DB) private readonly db: BetterSQLite3Database,
    @Inject(PRICE_HISTORY_PROVIDERS) private readonly providers: PriceHistoryProvider[],
  ) {}

  /**
   * Записать цену дня с учётом приоритета источников (PRICE_SOURCE_PRIORITY): более
   * слабый источник не затирает более сильный на ту же дату. true — строка записана.
   */
  record(instrumentId: string, point: HistoryPoint): boolean {
    return recordPrice(this.db, instrumentId, point);
  }

  /** Строки истории цен выбранных id за [from, till], по возрастанию даты */
  list(instrumentIds: readonly string[], from?: string, till?: string): PriceHistoryRow[] {
    if (instrumentIds.length === 0) return [];
    const conditions = [inArray(priceHistory.instrumentId, [...instrumentIds])];
    if (from) conditions.push(gte(priceHistory.date, from));
    if (till) conditions.push(lte(priceHistory.date, till));
    return this.db
      .select()
      .from(priceHistory)
      .where(and(...conditions))
      .all()
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Цели догрузки для бумаг: сами бумаги + курсы всех нерублёвых валют, которые встречаются
   * у инструментов, в их котировках (валюта цены и НКД) и в уже сохранённой истории.
   */
  targetsFor(instrumentIds: readonly string[]): HistoryTarget[] {
    if (instrumentIds.length === 0) return [];
    const rows = this.db.select().from(instruments).where(inArray(instruments.id, [...instrumentIds])).all();
    const currencies = new Set<string>();
    for (const i of rows) currencies.add(i.currency);
    for (const q of this.db.select().from(quotes).where(inArray(quotes.instrumentId, [...instrumentIds])).all()) {
      currencies.add(q.currency);
      if (q.accruedCurrency) currencies.add(q.accruedCurrency);
    }
    for (const h of this.db
      .select({ currency: priceHistory.currency, accrued: priceHistory.accruedCurrency })
      .from(priceHistory)
      .where(inArray(priceHistory.instrumentId, [...instrumentIds]))
      .groupBy(priceHistory.currency, priceHistory.accruedCurrency)
      .all()) {
      currencies.add(h.currency);
      if (h.accrued) currencies.add(h.accrued);
    }
    const fx: HistoryTarget[] = [...currencies]
      .map((c) => c.toUpperCase())
      .filter((c) => c !== 'RUB')
      .sort()
      .map((c) => ({
        instrumentId: fxInstrumentId(c),
        ticker: c,
        kind: 'fx' as const,
        type: 'Fx' as const,
        currency: 'RUB',
        marketSource: 'cbr' as const,
      }));
    return [
      ...rows.map((i) => ({
        instrumentId: i.id,
        ticker: i.ticker,
        kind: 'instrument' as const,
        type: i.type,
        currency: i.currency,
        marketSource: i.marketSource,
      })),
      ...fx,
    ];
  }

  /** Догрузить историю бумаг и их валют за [from, till] (см. ensure) */
  async ensureForInstruments(instrumentIds: readonly string[], from: string, till: string): Promise<void> {
    await this.ensure(this.targetsFor(instrumentIds), from, till);
  }

  /**
   * Догружает ТОЛЬКО отсутствующие диапазоны. «Покрыто» = между самой ранней и самой
   * поздней точкой РЫНОЧНОГО источника (isMarketSource): дыры внутри — выходные и праздники,
   * а снимки и ручные цены диапазон не закрывают (иначе единственная ручная точка
   * посреди периода выключила бы загрузку биржевой истории).
   *
   * Неудача источника не роняет расчёт: ошибка логируется, день остаётся «без цены»
   * (valuationSeries пометит его), повторная попытка — не чаще раза в час.
   */
  async ensure(targets: readonly HistoryTarget[], from: string, till: string): Promise<void> {
    for (const target of targets) {
      const provider = this.providers.find((p) => p.supports(target));
      if (!provider) continue;
      const failed = this.failedAt.get(target.instrumentId);
      if (failed !== undefined && Date.now() - failed < NEGATIVE_TTL_MS) continue;

      for (const [rangeFrom, rangeTill] of this.missingRanges(target.instrumentId, from, till)) {
        try {
          const points = await provider.getHistory(target, rangeFrom, rangeTill);
          if (points.length === 0) this.failedAt.set(target.instrumentId, Date.now());
          for (const p of points) this.record(target.instrumentId, p);
        } catch (err) {
          this.failedAt.set(target.instrumentId, Date.now());
          this.log.warn(`История цен ${target.ticker} ${rangeFrom}…${rangeTill}: ${(err as Error).message}`);
        }
      }
    }
  }

  /** Диапазоны [from, till], не покрытые рыночными точками: хвост до/после уже загруженного */
  private missingRanges(instrumentId: string, from: string, till: string): [string, string][] {
    const rows = this.db
      .select({ date: priceHistory.date, source: priceHistory.source })
      .from(priceHistory)
      .where(eq(priceHistory.instrumentId, instrumentId))
      .all()
      .filter((r) => isMarketSource(r.source as PriceSource))
      .map((r) => r.date)
      .sort();
    if (rows.length === 0) return [[from, till]];
    const first = rows[0];
    const last = rows[rows.length - 1];
    const ranges: [string, string][] = [];
    if (from < first) ranges.push([from, addDays(first, -1)]);
    if (till > last) ranges.push([addDays(last, 1), till]);
    return ranges;
  }
}
