import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { ManualPriceSchema } from '@core';
import { quotes, instruments, type QuoteRow } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { MoexProvider } from './moex.provider';
import { CbrProvider } from './cbr.provider';
import { BinanceProvider } from './binance.provider';
import type { PriceProvider } from './price-provider';
import { PriceHistoryService } from './price-history.service';
import { fxInstrumentId, type PriceSource } from '@core';

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
    private readonly history: PriceHistoryService,
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

  /** Курс валюты или null, если ЦЕНТРОБАНК недоступен/валюты нет (без подмены единицей) */
  async getFxRateOrNull(currency: string): Promise<number | null> {
    return this.cbr.getRateOrNull(currency);
  }

  /**
   * История индекса-бенчмарка (IMOEX по умолчанию) за период — прокси к MOEX ISS,
   * чтобы фронт не ходил на внешний источник напрямую (CORS + единая точка).
   */
  async benchmark(from: string, till: string, secid?: string) {
    return this.moex.getIndexHistory(from, till, secid || 'IMOEX');
  }

  /**
   * Цена дня в историю цен — «снимок», но ФАКТА (цена и НКД), а не посчитанного итога:
   * из истории любые ряды пересчитываются, и правка журнала задним числом ничего не портит.
   */
  private recordHistory(instrumentId: string, row: {
    price: string;
    currency: string;
    accruedInterest: string | null;
    accruedCurrency: string | null;
    source: PriceSource;
    asOf: string;
  }): void {
    this.history.record(instrumentId, {
      date: row.asOf.slice(0, 10),
      price: row.price,
      currency: row.currency,
      accruedInterest: row.accruedInterest,
      accruedCurrency: row.accruedCurrency,
      source: row.source,
    });
  }

  /** Курс каждой нерублёвой валюты котировок на сегодня — в ту же историю (fx:USD) */
  private async recordFxToday(currencies: Iterable<string>): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    for (const c of new Set([...currencies].map((x) => x.toUpperCase()))) {
      if (c === 'RUB') continue;
      const rate = await this.cbr.getRateOrNull(c);
      if (rate === null) continue; // «нет курса» не подменяем единицей
      this.history.record(fxInstrumentId(c), {
        date,
        price: String(rate),
        currency: 'RUB',
        accruedInterest: null,
        accruedCurrency: null,
        source: 'cbr',
      });
    }
  }

  /**
   * Обновить цены по всем инструментам из справочника.
   * Возвращает количество успешно обновлённых.
   */
  async refreshAll(): Promise<{ updated: number; total: number }> {
    const instrumentRows = this.db.select().from(instruments).all();
    let updated = 0;
    const currencies = new Set<string>();

    for (const inst of instrumentRows) {
      const provider = this.providers.find((p) => p.supports(inst.marketSource));
      if (!provider) continue; // manual — цену задаём вручную
      const quote = await provider.getQuote(inst.ticker);
      if (!quote) continue;

      /*
       * Валюта — та, в которой цену отдал источник, и только при её отсутствии
       * валюта инструмента. Раньше здесь всегда стояла валюта инструмента, потому
       * что MOEX ISS «не отдаёт валюту котировки»; на самом деле отдаёт — в
       * FACEUNIT облигации (см. moex.provider.ts). Разница принципиальна для
       * замещающих облигаций: цена приходит в долларах, а инструмент в справочнике
       * может числиться рублёвым (сделки-то рублёвые), и пересчёт по курсу
       * инструмента занижал стоимость позиции в десятки раз.
       */
      const currency = quote.currency || inst.currency;
      const accruedInterest = quote.accruedInterest ?? null;
      // валюта НКД своя (см. quotes.accruedCurrency); нет НКД — нет и валюты
      const accruedCurrency = accruedInterest === null ? null : quote.accruedInterestCurrency ?? currency;

      this.db
        .insert(quotes)
        .values({
          instrumentId: inst.id,
          price: quote.price,
          currency,
          accruedInterest,
          accruedCurrency,
          source: quote.source,
          asOf: quote.asOf,
        })
        .onConflictDoUpdate({
          target: quotes.instrumentId,
          // accruedInterest перезаписываем всегда, в том числе в null: после выплаты
          // купона НКД обнуляется, и «прилипший» прошлый завышал бы стоимость
          set: { price: quote.price, currency, accruedInterest, accruedCurrency, asOf: quote.asOf },
        })
        .run();
      this.recordHistory(inst.id, {
        price: quote.price,
        currency,
        accruedInterest,
        accruedCurrency,
        source: quote.source,
        asOf: quote.asOf,
      });
      currencies.add(currency);
      if (accruedCurrency) currencies.add(accruedCurrency);
      updated++;
    }
    await this.recordFxToday(currencies);

    return { updated, total: instrumentRows.length };
  }

  /**
   * Установить цену вручную — единственный способ показать «Тек. цену» для
   * инструмента с marketSource='manual' (напр. фонд с тикером, которого нет ни
   * на MOEX, ни на Binance): для него навсегда нет провайдера, refreshAll() его
   * просто пропускает (см. выше), а без этого метода цена так и оставалась бы
   * пустой бесконечно. Разрешаем только для marketSource='manual' — иначе
   * следующий клик «Обновить цены» молча перезапишет введённое пользователем
   * значение реальной котировкой, и правка выглядела бы как «пропала сама собой».
   */
  setManualPrice(instrumentId: string, raw: unknown): QuoteRow {
    const { price } = ManualPriceSchema.parse(raw);
    const [inst] = this.db.select().from(instruments).where(eq(instruments.id, instrumentId)).all();
    if (!inst) throw new NotFoundException(`Инструмент не найден: ${instrumentId}`);
    if (inst.marketSource !== 'manual') {
      throw new BadRequestException(
        `У инструмента «${inst.ticker}» уже есть автоматический источник цены (${inst.marketSource}) — ` +
          'ручная цена будет перезаписана следующим «Обновить цены».',
      );
    }

    const asOf = new Date().toISOString();
    // ручная цена — всегда в валюте инструмента (пользователь вводит её, глядя на
    // среднюю); НКД для неё неоткуда взять, поэтому явно сбрасываем в null
    this.db
      .insert(quotes)
      .values({
        instrumentId,
        price,
        currency: inst.currency,
        accruedInterest: null,
        accruedCurrency: null,
        source: 'manual',
        asOf,
      })
      .onConflictDoUpdate({
        target: quotes.instrumentId,
        set: {
          price,
          currency: inst.currency,
          accruedInterest: null,
          accruedCurrency: null,
          source: 'manual',
          asOf,
        },
      })
      .run();

    this.recordHistory(instrumentId, {
      price,
      currency: inst.currency,
      accruedInterest: null,
      accruedCurrency: null,
      source: 'manual',
      asOf,
    });

    const [row] = this.db.select().from(quotes).where(eq(quotes.instrumentId, instrumentId)).all();
    return row;
  }

  /**
   * Найти цену через подключённые провайдеры (MOEX/Binance) для инструмента без
   * автоматического источника (marketSource='manual'). Файловый импорт заводит
   * ЛЮБОЙ новый тикер как manual из осторожности (см. ensureInstruments() в
   * import.service.ts — «автоматически считать любой новый код торгуемым на MOEX
   * небезопасно»), даже когда бумага на самом деле торгуется на бирже под тем же
   * кодом (напр. БПИФ «GOLD» есть и в отчёте брокера, и на MOEX). Здесь пользователь
   * явно просит проверить — если провайдер отвечает, фиксируем marketSource на
   * найденный источник, и дальше «Обновить цены» подхватывает инструмент сама же.
   */
  async resolveViaApi(instrumentId: string): Promise<{ price: string; source: string }> {
    const [inst] = this.db.select().from(instruments).where(eq(instruments.id, instrumentId)).all();
    if (!inst) throw new NotFoundException(`Инструмент не найден: ${instrumentId}`);
    if (inst.marketSource !== 'manual') {
      throw new BadRequestException(
        `У инструмента «${inst.ticker}» уже есть автоматический источник цены (${inst.marketSource}).`,
      );
    }

    for (const provider of this.providers) {
      const quote = await provider.getQuote(inst.ticker);
      if (!quote) continue;

      // валюта и НКД — от источника, как и в refreshAll()
      const currency = quote.currency || inst.currency;
      const accruedInterest = quote.accruedInterest ?? null;
      const accruedCurrency = accruedInterest === null ? null : quote.accruedInterestCurrency ?? currency;

      this.db.update(instruments).set({ marketSource: quote.source }).where(eq(instruments.id, instrumentId)).run();
      this.db
        .insert(quotes)
        .values({
          instrumentId,
          price: quote.price,
          currency,
          accruedInterest,
          accruedCurrency,
          source: quote.source,
          asOf: quote.asOf,
        })
        .onConflictDoUpdate({
          target: quotes.instrumentId,
          set: {
            price: quote.price,
            currency,
            accruedInterest,
            accruedCurrency,
            source: quote.source,
            asOf: quote.asOf,
          },
        })
        .run();

      this.recordHistory(instrumentId, {
        price: quote.price,
        currency,
        accruedInterest,
        accruedCurrency,
        source: quote.source,
        asOf: quote.asOf,
      });
      return { price: quote.price, source: quote.source };
    }

    throw new NotFoundException(
      `Не нашлось котировки для «${inst.ticker}» ни на одной из подключённых площадок (MOEX, Binance).`,
    );
  }
}
