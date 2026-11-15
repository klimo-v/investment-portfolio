import { calendarDate, plainQuoteDecimal, quoteValuesIssue } from '@core';
import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { ManualPriceSchema } from '@core';
import { quotes, instruments, type QuoteRow } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { MoexProvider } from './moex.provider';
import { CbrProvider } from './cbr.provider';
import { BinanceProvider } from './binance.provider';
import type { PriceProvider, Quote } from './price-provider';
import { PriceHistoryService } from './price-history.service';
import { fxInstrumentId, type PriceSource, type QuoteRefreshResult } from '@core';

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

  /** Проверка обоих путей выполняется до первой записи, десятичные строки сохраняются точно. */
  private prepareQuote(inst: typeof instruments.$inferSelect, quote: Quote): QuoteRow {
    const issue = quoteValuesIssue(quote.price, quote.accruedInterest, inst.type === 'Future');
    if (issue) throw new Error(issue);
    if (!['moex', 'binance', 'cbr'].includes(quote.source))
      throw new Error('Некорректный источник котировки');
    if (!Number.isFinite(Date.parse(quote.asOf))) throw new Error('Некорректная дата котировки');
    const currency = quote.currency || inst.currency;
    const accruedInterest =
      quote.accruedInterest == null ? null : plainQuoteDecimal(quote.accruedInterest);
    return {
      instrumentId: inst.id,
      price: plainQuoteDecimal(quote.price),
      currency,
      accruedInterest,
      accruedCurrency:
        accruedInterest === null ? null : (quote.accruedInterestCurrency ?? currency),
      source: quote.source,
      asOf: quote.asOf,
    };
  }

  /** Одна SQLite-транзакция для котировки, истории (с её приоритетом) и источника. */
  private saveQuote(row: QuoteRow, changeSource = false): void {
    this.db.transaction((tx) => {
      tx.insert(quotes)
        .values(row)
        .onConflictDoUpdate({ target: quotes.instrumentId, set: row })
        .run();
      this.recordHistory(row.instrumentId, row);
      if (changeSource && row.source !== 'broker-report') {
        tx.update(instruments)
          .set({ marketSource: row.source })
          .where(eq(instruments.id, row.instrumentId))
          .run();
      }
    });
  }

  /** Текущие кэшированные котировки */
  list(): QuoteRow[] {
    return this.db
      .select()
      .from(quotes)
      .all()
      .map((row) =>
        quoteValuesIssue(row.price, row.accruedInterest, true)
          ? row
          : {
              ...row,
              price: plainQuoteDecimal(row.price),
              accruedInterest:
                row.accruedInterest === null ? null : plainQuoteDecimal(row.accruedInterest),
            },
      );
  }

  /** Курс валюты или null, если ЦЕНТРОБАНК недоступен/валюты нет (без подмены единицей) */
  async getFxRateOrNull(currency: string): Promise<number | null> {
    return this.cbr.getRateOrNull(currency);
  }

  /**
   * Цена дня в историю цен — «снимок», но ФАКТА (цена и НКД), а не посчитанного итога:
   * из истории любые ряды пересчитываются, и правка журнала задним числом ничего не портит.
   */
  private recordHistory(
    instrumentId: string,
    row: {
      price: string;
      currency: string;
      accruedInterest: string | null;
      accruedCurrency: string | null;
      source: PriceSource;
      asOf: string;
    },
  ): void {
    this.history.record(instrumentId, {
      date: row.asOf.slice(0, 10),
      price: row.price,
      currency: row.currency,
      accruedInterest: row.accruedInterest,
      accruedCurrency: row.accruedCurrency,
      // цена от провайдера в момент нажатия — не официальное закрытие дня (внутридневная LAST,
      // частичная свеча): помечаем 'quote', чтобы официальное значение заменило её при догрузке
      source: row.source === 'manual' ? 'manual' : 'quote',
    });
  }

  /** Курс каждой нерублёвой валюты котировок на сегодня — в ту же историю (fx:USD) */
  private async recordFxToday(currencies: Iterable<string>): Promise<void> {
    const date = calendarDate();
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
        // daily_json в пятницу после ~15:00 уже даёт курс на понедельник — не официальный курс дня
        source: 'quote',
      });
    }
  }

  /**
   * Обновить цены по всем инструментам из справочника.
   * Возвращает количество успешно обновлённых.
   */
  async refreshAll(): Promise<QuoteRefreshResult> {
    const instrumentRows = this.db.select().from(instruments).all();
    let updated = 0;
    let total = 0;
    let skippedManual = 0;
    const failures: QuoteRefreshResult['failures'] = [];
    const currencies = new Set<string>();

    for (const inst of instrumentRows) {
      if (inst.marketSource === 'manual') {
        skippedManual++;
        continue;
      }
      total++;
      const provider = this.providers.find((p) => p.supports(inst.marketSource));
      try {
        if (!provider) throw new Error('Источник не поддерживает обновление цены');
        const quote = await provider.getQuote(inst.ticker);
        if (!quote) throw new Error('Источник не вернул цену');
        const row = this.prepareQuote(inst, quote);
        this.saveQuote(row);
        currencies.add(row.currency);
        if (row.accruedCurrency) currencies.add(row.accruedCurrency);
        updated++;
      } catch (error) {
        failures.push({
          ticker: inst.ticker,
          source: inst.marketSource,
          reason: error instanceof Error ? error.message : 'Не удалось получить цену',
        });
      }
    }
    await this.recordFxToday(currencies);

    return { updated, total, skippedManual, failures };
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

    const issue = quoteValuesIssue(price, null, inst.type === 'Future');
    if (issue) throw new BadRequestException(issue);

    const asOf = new Date().toISOString();
    const currency = inst.type === 'Future' ? 'RUB' : inst.currency;
    this.saveQuote({
      instrumentId,
      price: plainQuoteDecimal(price),
      currency,
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
      let row: QuoteRow;
      try {
        const quote = await provider.getQuote(inst.ticker);
        if (!quote) continue;
        row = this.prepareQuote(inst, quote);
      } catch {
        // Только отсутствие/непригодность ответа разрешает поиск на следующей площадке.
        continue;
      }
      try {
        this.saveQuote(row, true);
      } catch (cause) {
        throw new InternalServerErrorException(
          `Цена для «${inst.ticker}» найдена (${row.source}), но сохранить её не удалось. Предыдущая цена сохранена.`,
          { cause },
        );
      }
      return { price: row.price, source: row.source };
    }

    throw new NotFoundException(
      `Не нашлось котировки для «${inst.ticker}» ни на одной из подключённых площадок (MOEX, Binance).`,
    );
  }
}
