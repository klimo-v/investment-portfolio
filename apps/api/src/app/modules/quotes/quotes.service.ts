import { Inject, Injectable } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { quotes, instruments, type QuoteRow } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { MoexProvider } from './moex.provider';
import { CbrProvider } from './cbr.provider';
import { BinanceProvider } from './binance.provider';
import type { PriceProvider } from './price-provider';

/**
 * Сервис котировок (CLAUDE.md §7: Facade над провайдерами).
 * Обновляет цены по инструментам через провайдеры и кэширует в таблицу quotes.
 * Курсы валют (CBR) хранит отдельно — они нужны для пересчёта в RUB.
 */
@Injectable()
export class QuotesService {
  /**
   * Источники цен, выбираемые по marketSource инструмента (OCP: новый рынок = новый
   * провайдер, ядро обновления не меняется). manual — без провайдера (руками).
   */
  private readonly providers: PriceProvider[];

  constructor(
    @Inject(DB) private readonly db: BetterSQLite3Database,
    private readonly moex: MoexProvider,
    private readonly cbr: CbrProvider,
    private readonly binance: BinanceProvider,
  ) {
    this.providers = [this.moex, this.binance];
  }

  /** Текущие кэшированные котировки */
  list(): QuoteRow[] {
    return this.db.select().from(quotes).all();
  }

  /** Курс валюты к RUB (для пересчёта стоимости валютных позиций) */
  async getFxRate(currency: string): Promise<number> {
    return this.cbr.getRate(currency);
  }

  /**
   * История индекса-бенчмарка (IMOEX по умолчанию) за период — прокси к MOEX ISS,
   * чтобы фронт не ходил на внешний источник напрямую (CORS + единая точка).
   */
  async benchmark(from: string, till: string, secid?: string) {
    return this.moex.getIndexHistory(from, till, secid || 'IMOEX');
  }

  /**
   * Обновить цены по всем инструментам из справочника.
   * Возвращает количество успешно обновлённых.
   */
  async refreshAll(): Promise<{ updated: number; total: number }> {
    const instrumentRows = this.db.select().from(instruments).all();
    let updated = 0;

    for (const inst of instrumentRows) {
      const provider = this.providers.find((p) => p.supports(inst.marketSource));
      if (!provider) continue; // manual — цену задаём вручную
      const quote = await provider.getQuote(inst.ticker);
      if (!quote) continue;

      // валюта — из своего справочника инструментов, а не от провайдера: MOEX ISS
      // не отдаёт валюту котировки напрямую (для валютных облигаций типа USD
      // цена в FACEVALUE может быть не в RUB), а инструмент уже хранит верную
      // валюту (docs/02-data-model.md) — единый источник правды вместо догадки
      this.db
        .insert(quotes)
        .values({
          instrumentId: inst.id,
          price: quote.price,
          currency: inst.currency,
          source: quote.source,
          asOf: quote.asOf,
        })
        .onConflictDoUpdate({
          target: quotes.instrumentId,
          set: { price: quote.price, currency: inst.currency, asOf: quote.asOf },
        })
        .run();
      updated++;
    }

    return { updated, total: instrumentRows.length };
  }
}
