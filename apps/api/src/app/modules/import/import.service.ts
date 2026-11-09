import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, lte, notLike, or } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import {
  attachParentFees,
  expandForeignCash,
  fxInstrumentId,
  identityKey,
  mergeBrokerFields,
  normalizeRawRows,
  normalizeRow,
  makeDedupeKey,
  parseBrokerHtmlReportWithMarks,
  type FieldChange,
  type ForeignCashLookups,
  type IdentityChoice,
  type InstrumentIdentifiers,
  type InstrumentSuggestion,
  type RowIdentity,
  type FuturesSettlement,
  type RawRow,
  type CurrencyBalance,
  type Operation,
  journalCurrencyBalances,
  type FuturesMark,
} from '@core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  futuresSettlements,
  operations,
  systems,
  portfolios,
  instruments,
  quotes,
  priceHistory,
  type OperationRow,
} from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { InstrumentIdentityService } from '../instruments/instrument-identity.service';
import { recordPrice } from '../../../db/price-history-store';
import { parseCsv } from './csv-parser';
import { parseTbankXlsx } from './tbank-xlsx-report';

/** Результат разбора файла, лежащий в кэше загрузок */
interface ParsedUpload {
  rows: RawRow[];
  marks: FuturesMark[];
  /** вариационная маржа из отчёта — для сверки, в журнал не попадает */
  settlements: FuturesSettlement[];
}

/** Одна строка предпросмотра импорта */
export interface PreviewRow {
  operation?: Operation;
  /**
   * 'update' — операция с таким номером у брокера уже есть, но брокер прислал другие
   * значения (например, комиссия пришла позже): при подтверждении обновится существующая
   * операция, а не создастся новая. Разметка пользователя (система, заметки) не трогается.
   */
  confidence: 'ok' | 'warn' | 'error' | 'duplicate' | 'update';
  /** для 'update': id существующей операции и что в ней изменится («было → станет») */
  existingId?: string;
  changes?: FieldChange[];
  reason?: string;
  /** Признак счёта из отчёта (docs/04-roadmap.md §3.1) — для авто-обучения маппинга при commit() */
  accountRef?: string;
  /** Тикер строки (для выбора системы по тикеру в рамках этого импорта, §3.1) */
  ticker?: string;
  /** Система назначена батч-дефолтом, а не выбрана явно для этого тикера — строка требует проверки (§3.1) */
  systemUncertain?: boolean;
}

/** Инструмент, которого ещё нет в справочнике: пользователь выбирает «новый / существующий» */
export interface UnresolvedInstrument {
  /** код строки — ключ в `instrumentChoices` */
  key: string;
  name: string | null;
  instrumentType: string;
  currency: string;
  identifiers: InstrumentIdentifiers;
  /** похожие существующие инструменты (эвристики), сильнейшие первыми */
  suggestions: InstrumentSuggestion[];
}

export interface PreviewResult {
  rows: PreviewRow[];
  /** Новые инструменты, которые заведёт commit(), с подсказками о возможных дублях */
  unresolvedInstruments: UnresolvedInstrument[];
  summary: { total: number; ok: number; warn: number; error: number; duplicate: number; update: number };
  /** Расчётные цены фьючерсов из отчёта — при commit() сохраняются как цена инструмента на дату отчёта */
  marks: FuturesMark[];
  /** Id уже распарсенного файла — передать в следующий preview()/commit() вместо content (см. ImportInput) */
  uploadId: string;
}

/** Формат исходного файла (Factory: новый брокер = новый парсер, OCP) */
export type ImportFormat = 'csv' | 'html' | 'xlsx';

/**
 * Параметры импорта. systemId/portfolioId — разметка на весь батч: в отчётах
 * брокеров этих полей нет (система — классификация пользователя, портфель несёт
 * брокера), поэтому выбираются в UI и служат значением по умолчанию для строк,
 * где в самом файле система/брокер не заданы.
 *
 * tickerSystemOverrides — точечный выбор системы по тикеру **в рамках этого же
 * импорта** (docs/04-roadmap.md §3.1): один и тот же тикер в разное время может
 * относиться к разным системам (это решение пользователя, а не свойство тикера),
 * поэтому — в отличие от `accountRef`→портфель — здесь ничего не запоминается
 * между импортами: карта живёт только в текущем запросе preview/commit.
 */
export interface ImportOptions {
  format?: ImportFormat;
  systemId?: string | null;
  portfolioId?: string | null;
  tickerSystemOverrides?: Record<string, string>;
  /**
   * Решения по неопознанным инструментам: ключ — код строки (`identityKey`), значение —
   * «новый» или «это существующий инструмент X». Существующий записывается как
   * идентификаторы с origin 'manual', поэтому следующий импорт опознаёт сам.
   */
  instrumentChoices?: Record<string, IdentityChoice>;
}

/**
 * Вход preview()/commit(). Первый вызов для файла обязан передать `content`
 * (весь файл — CSV/HTML текстом, xlsx base64). Каждая правка батч-разметки или
 * точечного выбора системы по тикеру (docs/04-roadmap.md §3.1) заново вызывает
 * preview(), но НЕ должна пересылать и заново парсить весь файл — при большом
 * xlsx-отчёте (Т-Банк, тысячи строк) это и лишний трафик, и лишний CPU на
 * повторный разбор rich-text ячеек. Вместо этого передаётся `uploadId` из
 * ответа первого preview() — сырые строки уже лежат в кэше `uploads`.
 */
export interface ImportInput extends ImportOptions {
  content?: string;
  uploadId?: string;
}

/**
 * Сервис импорта (Facade). Конвейер: CSV → RawRow → нормализация/классификация
 * (движок @core) → дедупликация → предпросмотр/сохранение (docs/02-data-model.md §6).
 */
@Injectable()
export class ImportService {
  constructor(
    @Inject(DB) private readonly db: BetterSQLite3Database,
    private readonly identity: InstrumentIdentityService,
  ) {}

  /**
   * Кэш уже распарсенных файлов на время правки батч-разметки/тикер-выбора
   * (см. ImportInput). Однопользовательское локальное приложение — простой
   * Map с ограничением размера вместо TTL/внешнего кэша (YAGNI).
   */
  private readonly uploads = new Map<string, ParsedUpload>();
  private static readonly MAX_UPLOADS = 20;

  /** Строки файла: из кэша по uploadId либо свежий разбор content (Factory: формат → парсер) */
  private async resolveRawRows(
    input: ImportInput,
  ): Promise<ParsedUpload & { uploadId: string }> {
    if (input.uploadId) {
      const cached = this.uploads.get(input.uploadId);
      if (cached) return { ...cached, uploadId: input.uploadId };
      if (!input.content) {
        throw new BadRequestException('Файл больше не в кэше — выберите его заново');
      }
    }
    const parsed = await this.parseFile(input.content ?? '', input.format);
    const uploadId = this.stashRawRows(parsed.rows, input.uploadId, parsed.marks, parsed.settlements);
    return { ...(this.uploads.get(uploadId) as ParsedUpload), uploadId };
  }

  /**
   * Количество каждой иностранной валюты в журнале портфеля, привязанного к счёту `accountRef`
   * (для сверки с остатками брокера). Портфель не найден — пустой список.
   */
  journalCurrencyBalancesByAccount(accountRef: string): CurrencyBalance[] {
    const [portfolio] = this.db.select().from(portfolios).where(eq(portfolios.accountRef, accountRef)).all();
    if (!portfolio) return [];
    const tickers = new Map(this.db.select({ id: instruments.id, ticker: instruments.ticker }).from(instruments).all().map((i) => [i.id, i.ticker]));
    const ops = this.db.select().from(operations).where(eq(operations.portfolioId, portfolio.id)).all();
    return journalCurrencyBalances(ops as Operation[], (id) => tickers.get(id));
  }

  /**
   * Сделки валютной пары за день из журнала. Синтетические покупки/продажи ввода и вывода валюты
   * (`transferGroup = fx:…`) не считаются: курс задаёт реальная сделка, а не конвертация, созданная
   * самим правилом. Если счёт известен — только его портфель (чужой счёт курса не задаёт).
   */
  private journalDayTrades(pairTicker: string, date: string, side: 'Buy' | 'Sell', accountRef?: string) {
    const portfolio = accountRef
      ? this.db.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.accountRef, accountRef)).get()
      : undefined;
    return this.db
      .select({ quantity: operations.quantity, price: operations.price })
      .from(operations)
      .innerJoin(instruments, eq(instruments.id, operations.instrumentId))
      .where(
        and(
          eq(instruments.ticker, pairTicker),
          eq(operations.date, date),
          eq(operations.operationType, side),
          or(isNull(operations.transferGroup), notLike(operations.transferGroup, 'fx:%')),
          portfolio ? eq(operations.portfolioId, portfolio.id) : undefined,
        ),
      )
      .all();
  }

  /** Источники курсов для `expandForeignCash`: ЦБ из истории цен (fx:CCY) и продажи валютной пары в журнале */
  private foreignCashLookups(): ForeignCashLookups {
    return {
      cbrRate: (currency, date) =>
        this.db
          .select({ price: priceHistory.price })
          .from(priceHistory)
          .where(and(eq(priceHistory.instrumentId, fxInstrumentId(currency)), lte(priceHistory.date, date)))
          .orderBy(desc(priceHistory.date))
          .limit(1)
          .get()?.price ?? null,
      journalSales: (pairTicker, date, accountRef) => this.journalDayTrades(pairTicker, date, 'Sell', accountRef),
      journalBuys: (pairTicker, date, accountRef) => this.journalDayTrades(pairTicker, date, 'Buy', accountRef),
    };
  }

  /**
   * Кладёт готовые строки в кэш загрузок и возвращает `uploadId`.
   *
   * Публичный, потому что источником строк может быть не файл: синхронизация с
   * T-Invest API (`tbank/tbank-sync.service.ts`) складывает сюда свой `RawRow[]`,
   * после чего фронт вызывает те же самые preview()/commit() с этим uploadId —
   * весь конвейер ниже парсера остаётся общим для файлов и API (CLAUDE.md §7, DRY).
   */
  stashRawRows(
    rows: RawRow[],
    reuseId?: string,
    marks: FuturesMark[] = [],
    settlements: FuturesSettlement[] = [],
  ): string {
    const uploadId = reuseId ?? randomUUID();
    // общие шаги нормализации для ЛЮБОГО источника (файлы и API сходятся именно здесь):
    // комиссия отдельной строкой по ссылке на сделку прибавляется к fee сделки
    // (core/import.ts: attachParentFees); коды инструментов приводятся к единому виду,
    // ISIN/figi/uid раскладываются по идентификаторам (core: normalizeRawRows)
    // нерублёвые деньги: валютное пополнение/вывод → пара обычных операций, курс обязателен (core/foreign-cash.ts)
    const expanded = expandForeignCash(attachParentFees(rows), this.foreignCashLookups());
    this.uploads.set(uploadId, { rows: normalizeRawRows(expanded), marks, settlements });
    if (this.uploads.size > ImportService.MAX_UPLOADS) {
      const oldest = this.uploads.keys().next().value;
      if (oldest) this.uploads.delete(oldest);
    }
    return uploadId;
  }

  /**
   * Дата последней операции в базе (`YYYY-MM-DD`) либо null, если журнал пуст.
   * Нужна синхронизации с API как значение по умолчанию для начала периода:
   * так пользователь не перетягивает заново то, что уже импортировано из файла.
   */
  lastOperationDate(): string | null {
    const [row] = this.db
      .select({ date: operations.date })
      .from(operations)
      .orderBy(desc(operations.date))
      .limit(1)
      .all();
    return row?.date ?? null;
  }

  /**
   * Резолверы имён из справочников в id (по имени/тикеру). Батч-дефолты
   * (systemId/portfolioId из UI) используются как запасной вариант, когда в самой
   * строке система/брокер не заданы (напр. HTML-отчёт брокера).
   */
  private buildResolvers(
    rawRows: RawRow[],
    defaults?: {
      systemId?: string | null;
      portfolioId?: string | null;
      tickerSystemOverrides?: Record<string, string>;
    },
    /** резолв инструментов строк (план core/instrument-identity.ts) */
    identities?: Map<RawRow, RowIdentity>,
  ) {
    const systemRows = this.db.select().from(systems).all();
    const portfolioRows = this.db.select().from(portfolios).all();

    const systemByName = new Map(systemRows.map((s) => [s.name.toLowerCase(), s.id]));
    // выбор системы по тикеру для ЭТОГО импорта (docs/04-roadmap.md §3.1) — не
    // сохраняется между импортами, т.к. один и тот же тикер в разное время может
    // относиться к разным системам (решение пользователя, а не свойство тикера)
    const tickerOverrides = new Map(
      Object.entries(defaults?.tickerSystemOverrides ?? {}).map(([t, s]) => [t.toLowerCase(), s]),
    );
    const portfolioByName = new Map(portfolioRows.map((p) => [p.name.toLowerCase(), p.id]));
    // persisted-маппинг «счёт отчёта → портфель» (docs/04-roadmap.md §3.1) — один
    // раз выбрали портфель для незнакомого accountRef при commit(), дальше резолвится сам
    const portfolioByAccountRef = new Map(
      portfolioRows.filter((p) => p.accountRef).map((p) => [p.accountRef as string, p.id]),
    );
    return {
      resolveSystem: (name?: string, ticker?: string) => {
        if (name) {
          const hit = systemByName.get(name.toLowerCase());
          if (hit) return hit;
        }
        if (ticker) {
          const hit = tickerOverrides.get(ticker.toLowerCase());
          if (hit) return hit;
        }
        return defaults?.systemId ?? null;
      },
      systemChosenForTicker: (ticker?: string) => !!ticker && tickerOverrides.has(ticker.toLowerCase()),
      resolvePortfolio: (accountRef?: string) => {
        if (accountRef) {
          // сначала точный persisted-маппинг, затем эвристика по имени портфеля
          // (полезна до первого commit(), пока маппинга ещё нет)
          const hit = portfolioByAccountRef.get(accountRef) ?? portfolioByName.get(accountRef.toLowerCase());
          if (hit) return hit;
        }
        return defaults?.portfolioId ?? null;
      },
      resolveInstrument: (raw: RawRow) => {
        const hit = identities?.get(raw);
        return hit
          ? { instrumentId: hit.instrumentId, conflict: hit.conflict, isNew: hit.isNew, suggestions: hit.suggestions }
          : { instrumentId: null };
      },
    };
  }

  /**
   * Авто-обучение маппинга «счёт отчёта → портфель» (docs/04-roadmap.md §3.1):
   * после успешного импорта запоминаем, в какой портфель попал незнакомый
   * accountRef, чтобы дальше он резолвился без участия пользователя. Не
   * перезаписывает существующие связи молча — ни когда accountRef уже привязан
   * (к этому или другому портфелю), ни когда у портфеля уже есть другой accountRef.
   */
  private learnAccountMapping(accountRef: string, portfolioId: string): void {
    const linkedElsewhere = this.db
      .select()
      .from(portfolios)
      .where(eq(portfolios.accountRef, accountRef))
      .all();
    if (linkedElsewhere.length > 0) return;

    const target = this.db.select().from(portfolios).where(eq(portfolios.id, portfolioId)).all();
    if (target.length === 0 || target[0].accountRef) return;

    this.db.update(portfolios).set({ accountRef }).where(eq(portfolios.id, portfolioId)).run();
  }

  /**
   * Разбор исходного файла нужным парсером (Factory: формат → парсер). xlsx —
   * бинарный формат, `content` для него — base64 (CSV/HTML передаются текстом).
   */
  private async parseFile(content: string, format: ImportFormat = 'csv'): Promise<ParsedUpload> {
    if (format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      // exceljs резолвит собственную (более старую) версию @types/node с иначе
      // параметризованным Buffer — структурно несовместимо на уровне типов,
      // хотя рантайм-объект тот же самый Buffer.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buf = Buffer.from(content, 'base64') as any;
      // ignoreNodes: реальный отчёт Т-Банка (1200+ строк) разбирался ~30 секунд —
      // весь разбор уходил на парсинг диапазонов mergeCells; сами значения ячеек
      // хранятся отдельно от merge-разметки, поэтому её пропуск не меняет
      // результат (проверено побайтовым сравнением), а разбор занимает ~200мс.
      await workbook.xlsx.load(buf, { ignoreNodes: ['mergeCells'] });
      const ws = workbook.worksheets[0];
      return { rows: ws ? parseTbankXlsx(ws) : [], marks: [], settlements: [] };
    }
    if (format === 'html') return parseBrokerHtmlReportWithMarks(content);
    return { rows: parseCsv(content), marks: [], settlements: [] };
  }

  /** Существующие операции по ключу дедупликации (чтобы не задвоить и находить кандидатов на обновление) */
  private existingByDedupeKey(): Map<string, OperationRow> {
    const map = new Map<string, OperationRow>();
    for (const o of this.db.select().from(operations).all()) {
      const key = makeDedupeKey({
        date: o.date,
        systemId: o.systemId,
        portfolioId: o.portfolioId,
        instrumentId: o.instrumentId,
        operationType: o.operationType as Operation['operationType'],
        quantity: o.quantity,
        price: o.price,
        fee: o.fee,
        fxRate: o.fxRate,
        currency: o.currency,
        brokerRef: o.brokerRef ?? undefined,
      });
      if (!map.has(key)) map.set(key, o);
    }
    return map;
  }

  /** Предпросмотр (dry-run): распознаёт строки, но ничего не пишет */
  async preview(input: ImportInput): Promise<PreviewResult> {
    const { rows: rawRows, marks, uploadId } = await this.resolveRawRows(input);
    // dry-run резолва инструментов: ничего не пишет, commit применяет ТОТ ЖЕ план
    const plan = this.identity.plan(rawRows, input.instrumentChoices);
    const identities = new Map(rawRows.map((raw, i) => [raw, plan.rows[i]] as const));
    const resolvers = this.buildResolvers(
      rawRows,
      {
        systemId: input.systemId,
        portfolioId: input.portfolioId,
        tickerSystemOverrides: input.tickerSystemOverrides,
      },
      identities,
    );
    const existing = this.existingByDedupeKey();
    const seenInBatch = new Set<string>();

    const rows: PreviewRow[] = rawRows.map((raw) => {
      const res = normalizeRow(raw, resolvers);
      if ('error' in res) {
        return { confidence: 'error', reason: res.error };
      }
      // ключ для UI выбора системы — резолвленный инструмент, если есть, иначе
      // сырой тикер/ISIN (то же самое, что и systemKey в normalizeRow, §3.1):
      // один и тот же актив брокер может репортить то тикером, то ISIN — выбор
      // системы для "SBER" должен применяться и к строке, пришедшей по её ISIN.
      const ticker = res.operation.instrumentId ?? identityKey(raw);
      // уже есть в базе: полное совпадение — дубль; тот же номер у брокера в том же портфеле
      // с другими значениями (комиссия пришла позже и т. п.) — обновление существующей
      const stored = existing.get(res.dedupeKey);
      if (stored && res.operation.brokerRef && stored.portfolioId === res.operation.portfolioId && !seenInBatch.has(res.dedupeKey)) {
        const changes = mergeBrokerFields(stored, res.operation);
        if (changes.length > 0) {
          seenInBatch.add(res.dedupeKey);
          return {
            operation: res.operation,
            confidence: 'update',
            existingId: stored.id,
            changes,
            reason: 'Данные брокера изменились — операция будет обновлена',
            accountRef: raw.accountRef,
            ticker,
            systemUncertain: false,
          };
        }
      }
      // дедуп против БД и внутри самого файла
      if (stored || seenInBatch.has(res.dedupeKey)) {
        return {
          operation: res.operation,
          confidence: 'duplicate',
          reason: 'Уже есть в базе',
          accountRef: raw.accountRef,
          ticker,
          systemUncertain: res.systemUncertain,
        };
      }
      seenInBatch.add(res.dedupeKey);
      return {
        operation: res.operation,
        confidence: res.confidence,
        reason: res.reason,
        accountRef: raw.accountRef,
        ticker,
        systemUncertain: res.systemUncertain,
      };
    });

    const summary = {
      total: rows.length,
      ok: rows.filter((r) => r.confidence === 'ok').length,
      warn: rows.filter((r) => r.confidence === 'warn').length,
      error: rows.filter((r) => r.confidence === 'error').length,
      duplicate: rows.filter((r) => r.confidence === 'duplicate').length,
      update: rows.filter((r) => r.confidence === 'update').length,
    };
    const unresolvedInstruments: UnresolvedInstrument[] = [];
    rawRows.forEach((raw, i) => {
      const id = plan.rows[i];
      const created = id.isNew ? plan.created.find((c) => c.id === id.instrumentId) : undefined;
      if (!id.key || !created) return;
      unresolvedInstruments.push({
        key: id.key,
        name: created.name,
        instrumentType: created.type,
        currency: created.currency,
        identifiers: raw.identifiers ?? {},
        suggestions: id.suggestions,
      });
    });
    return { rows, unresolvedInstruments, summary, marks, uploadId };
  }

  /** Импорт: сохраняет все ok/warn строки (не error, не duplicate) под общим batchId */
  async commit(input: ImportInput): Promise<{ batchId: string; imported: number; updated: number }> {
    // применяем план резолва инструментов (новые инструменты, идентификаторы, выбор
    // пользователя) ДО preview(): тот пересчитает план уже по обновлённому справочнику
    // и найдёт всё по идентификаторам
    const { rows: rawRows, settlements } = await this.resolveRawRows(input);
    this.identity.apply(this.identity.plan(rawRows, input.instrumentChoices));

    const preview = await this.preview(input);
    const batchId = randomUUID();
    let imported = 0;
    let updated = 0;
    let earliestDate: string | null = null;
    let earliestUpdateDate: string | null = null;
    const learnedRefs = new Set<string>();

    for (const row of preview.rows) {
      if (!row.operation) continue;
      if (row.confidence === 'error' || row.confidence === 'duplicate') continue;

      if (row.confidence === 'update') {
        // обновляем ТОЛЬКО поля, за которые отвечает брокер (core/import.ts:
        // mergeBrokerFields); система, заметки и прочая разметка остаются как были
        const patch: Record<string, string> = {};
        for (const c of row.changes ?? []) patch[c.field] = c.to;
        if (row.existingId && Object.keys(patch).length > 0) {
          this.db.update(operations).set(patch).where(eq(operations.id, row.existingId)).run();
          updated++;
          if (earliestUpdateDate === null || row.operation.date < earliestUpdateDate) {
            earliestUpdateDate = row.operation.date;
          }
        }
        continue;
      }

      this.db
        .insert(operations)
        .values({
          id: randomUUID(),
          date: row.operation.date,
          systemId: row.operation.systemId,
          portfolioId: row.operation.portfolioId,
          instrumentId: row.operation.instrumentId ?? null,
          operationType: row.operation.operationType,
          quantity: row.operation.quantity,
          price: row.operation.price,
          fee: row.operation.fee ?? '0',
          fxRate: row.operation.fxRate ?? '1',
          currency: row.operation.currency,
          note: row.operation.note ?? null,
          brokerRef: row.operation.brokerRef ?? null,
          executedAt: row.operation.executedAt ?? null,
          transferGroup: row.operation.transferGroup ?? null,
          sourceCode: row.operation.sourceCode ?? null,
          importBatchId: batchId,
        })
        .run();
      imported++;
      if (earliestDate === null || row.operation.date < earliestDate) {
        earliestDate = row.operation.date;
      }

      if (row.accountRef && !learnedRefs.has(row.accountRef)) {
        learnedRefs.add(row.accountRef);
        this.learnAccountMapping(row.accountRef, row.operation.portfolioId);
      }
    }

    this.saveMarks(preview.marks);
    this.saveSettlements(settlements, input);
    this.uploads.delete(preview.uploadId);

    return { batchId, imported, updated };
  }

  /**
   * Вариационная маржа из отчёта → таблица futures_settlements (upsert по портфель ×
   * инструмент × дата конца периода). Только для сверки, в операции не попадает.
   * Портфель — тем же резолвером, что и у строк отчёта (по признаку счёта, затем
   * батч-дефолт); если портфель или инструмент не найден — строка пропускается.
   */
  private saveSettlements(settlements: FuturesSettlement[], input: ImportOptions): void {
    if (settlements.length === 0) return;
    const { resolvePortfolio } = this.buildResolvers([], {
      systemId: input.systemId,
      portfolioId: input.portfolioId,
    });
    for (const st of settlements) {
      const portfolioId = resolvePortfolio(st.accountRef);
      const instrumentId = this.identity.findByTicker(st.ticker);
      if (!portfolioId || !instrumentId) continue;
      const values = {
        periodFrom: st.periodFrom,
        vmPeriod: st.vmPeriod,
        vmPlanned: st.vmPlanned,
        qtyStart: st.qtyStart,
        markStart: st.markStart,
        markEnd: st.markEnd,
        source: 'broker-report',
      };
      this.db
        .insert(futuresSettlements)
        .values({ portfolioId, instrumentId, date: st.date, ...values })
        .onConflictDoUpdate({
          target: [futuresSettlements.portfolioId, futuresSettlements.instrumentId, futuresSettlements.date],
          set: values,
        })
        .run();
    }
  }

  /**
   * Расчётные цены фьючерсов из отчёта → цена инструмента на дату отчёта (источник
   * `manual`, валюта RUB). Только для существующих инструментов с marketSource='manual'
   * (у остальных есть свой провайдер котировок). Более свежую цену не затираем:
   * даты сравниваем по первым 10 символам ISO-строки `asOf`. Откат импорта цену не
   * возвращает — это ожидаемо (цена — факт рынка на дату, а не часть операций).
   */
  private saveMarks(marks: FuturesMark[]): void {
    for (const mark of marks) {
      const instrumentId = this.identity.findByTicker(mark.ticker);
      const [inst] = instrumentId ? this.db.select().from(instruments).where(eq(instruments.id, instrumentId)).all() : [];
      if (!inst || inst.marketSource !== 'manual') continue;

      // история цен — независимо от того, свежее ли это текущей котировки: цена на СВОЮ дату
      // расчётная цена на дату отчёта — факт для истории цен (приоритет выше ручной цены)
      recordPrice(this.db, inst.id, {
        date: mark.date,
        price: mark.price,
        currency: 'RUB',
        accruedInterest: null,
        accruedCurrency: null,
        source: 'broker-report',
      });

      const [current] = this.db.select().from(quotes).where(eq(quotes.instrumentId, inst.id)).all();
      if (current && current.asOf.slice(0, 10) > mark.date) continue;

      const values = {
        price: mark.price,
        currency: 'RUB',
        accruedInterest: null,
        accruedCurrency: null,
        source: 'manual' as const,
        asOf: `${mark.date}T00:00:00.000Z`,
      };
      this.db
        .insert(quotes)
        .values({ instrumentId: inst.id, ...values })
        .onConflictDoUpdate({ target: quotes.instrumentId, set: values })
        .run();
    }
  }

  /**
   * Откат импорта: удаляет все операции указанной загрузки. Ряды динамики пересчитаются
   * из журнала при следующем запросе.
   */
  rollback(batchId: string): { deleted: number } {
    const toDelete = this.db
      .select()
      .from(operations)
      .where(eq(operations.importBatchId, batchId))
      .all();
    this.db.delete(operations).where(eq(operations.importBatchId, batchId)).run();

    return { deleted: toDelete.length };
  }
}
