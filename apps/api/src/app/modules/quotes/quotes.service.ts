import { Inject, Injectable } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { quotes, instruments, type QuoteRow } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { MoexProvider } from './moex.provider';
import { CbrProvider } from './cbr.provider';

/**
 * Сервис котировок (CLAUDE.md §7: Facade над провайдерами).
 * Обновляет цены по инструментам через провайдеры и кэширует в таблицу quotes.
 * Курсы валют (CBR) хранит отдельно — они нужны для пересчёта в RUB.
 */
@Injectable()
export class QuotesService {
  constructor(
    @Inject(DB) private readonly db: BetterSQLite3Database,
    private readonly moex: MoexProvider,
    private readonly cbr: CbrProvider,
  ) {}

  /** Текущие кэшированные котировки */
  list(): QuoteRow[] {
    return this.db.select().from(quotes).all();
  }

  /** Курс валюты к RUB (для пересчёта стоимости валютных позиций) */
  async getFxRate(currency: string): Promise<number> {
    return this.cbr.getRate(currency);
  }

  /**
   * Обновить цены по всем инструментам из справочника.
   * Возвращает количество успешно обновлённых.
   */
  async refreshAll(): Promise<{ updated: number; total: number }> {
    const instrumentRows = this.db.select().from(instruments).all();
    let updated = 0;

    for (const inst of instrumentRows) {
      if (inst.marketSource !== 'moex') continue; // крипта/manual — позже/вручную
      const quote = await this.moex.getQuote(inst.ticker);
      if (!quote) continue;

      this.db
        .insert(quotes)
        .values({
          instrumentId: inst.id,
          price: quote.price,
          currency: quote.currency,
          source: quote.source,
          asOf: quote.asOf,
        })
        .onConflictDoUpdate({
          target: quotes.instrumentId,
          set: { price: quote.price, currency: quote.currency, asOf: quote.asOf },
        })
        .run();
      updated++;
    }

    return { updated, total: instrumentRows.length };
  }
}
