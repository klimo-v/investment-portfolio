import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { normalizeRow, makeDedupeKey, parseBrokerHtmlReport, type RawRow, type Operation } from '@core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { operations, systems, portfolios, instruments } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { parseCsv } from './csv-parser';
import { parseTbankXlsx } from './tbank-xlsx-report';

/** Одна строка предпросмотра импорта */
export interface PreviewRow {
  operation?: Operation;
  confidence: 'ok' | 'warn' | 'error' | 'duplicate';
  reason?: string;
  /** Признак счёта из отчёта (docs/04-roadmap.md §3.1) — для авто-обучения маппинга при commit() */
  accountRef?: string;
  /** Тикер строки (для выбора системы по тикеру в рамках этого импорта, §3.1) */
  ticker?: string;
  /** Система назначена батч-дефолтом, а не выбрана явно для этого тикера — строка требует проверки (§3.1) */
  systemUncertain?: boolean;
}

export interface PreviewResult {
  rows: PreviewRow[];
  summary: { total: number; ok: number; warn: number; error: number; duplicate: number };
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
}

/**
 * Сервис импорта (Facade). Конвейер: CSV → RawRow → нормализация/классификация
 * (движок @core) → дедупликация → предпросмотр/сохранение (docs/02-data-model.md §6).
 */
@Injectable()
export class ImportService {
  constructor(@Inject(DB) private readonly db: BetterSQLite3Database) {}

  /**
   * Резолверы имён из справочников в id (по имени/тикеру). Батч-дефолты
   * (systemId/portfolioId из UI) используются как запасной вариант, когда в самой
   * строке система/брокер не заданы (напр. HTML-отчёт брокера).
   */
  private buildResolvers(defaults?: {
    systemId?: string | null;
    portfolioId?: string | null;
    tickerSystemOverrides?: Record<string, string>;
  }) {
    const systemRows = this.db.select().from(systems).all();
    const portfolioRows = this.db.select().from(portfolios).all();
    const instrumentRows = this.db.select().from(instruments).all();

    const systemByName = new Map(systemRows.map((s) => [s.name.toLowerCase(), s.id]));
    // выбор системы по тикеру для ЭТОГО импорта (docs/04-roadmap.md §3.1) — не
    // сохраняется между импортами, т.к. один и тот же тикер в разное время может
    // относиться к разным системам (решение пользователя, а не свойство тикера)
    const tickerOverrides = new Map(
      Object.entries(defaults?.tickerSystemOverrides ?? {}).map(([t, s]) => [t.toLowerCase(), s]),
    );
    const portfolioByBroker = new Map(portfolioRows.map((p) => [p.broker.toLowerCase(), p.id]));
    const portfolioByName = new Map(portfolioRows.map((p) => [p.name.toLowerCase(), p.id]));
    // persisted-маппинг «счёт отчёта → портфель» (docs/04-roadmap.md §3.1) — один
    // раз выбрали портфель для незнакомого accountRef при commit(), дальше резолвится сам
    const portfolioByAccountRef = new Map(
      portfolioRows.filter((p) => p.accountRef).map((p) => [p.accountRef as string, p.id]),
    );
    const instrumentByTicker = new Map(instrumentRows.map((i) => [i.ticker.toLowerCase(), i.id]));
    // фоллбэк по ISIN — некоторые брокеры репортят один и тот же инструмент то
    // тикером, то ISIN-кодом в зависимости от площадки/типа сделки (§3.1-подобный
    // случай, но для инструментов, не для систем/счетов)
    const instrumentByIsin = new Map(
      instrumentRows.filter((i) => i.isin).map((i) => [(i.isin as string).toLowerCase(), i.id]),
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
      resolvePortfolio: (broker?: string, accountRef?: string) => {
        if (broker) {
          const hit =
            portfolioByBroker.get(broker.toLowerCase()) ?? portfolioByName.get(broker.toLowerCase());
          if (hit) return hit;
        }
        if (accountRef) {
          // сначала точный persisted-маппинг, затем эвристика по имени портфеля
          // (полезна до первого commit(), пока маппинга ещё нет)
          const hit = portfolioByAccountRef.get(accountRef) ?? portfolioByName.get(accountRef.toLowerCase());
          if (hit) return hit;
        }
        return defaults?.portfolioId ?? null;
      },
      resolveInstrument: (ticker?: string) =>
        ticker
          ? (instrumentByTicker.get(ticker.toLowerCase()) ??
            instrumentByIsin.get(ticker.toLowerCase()) ??
            null)
          : null,
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
  private async parseFile(content: string, format: ImportFormat = 'csv'): Promise<RawRow[]> {
    if (format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      // exceljs резолвит собственную (более старую) версию @types/node с иначе
      // параметризованным Buffer — структурно несовместимо на уровне типов,
      // хотя рантайм-объект тот же самый Buffer.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await workbook.xlsx.load(Buffer.from(content, 'base64') as any);
      const ws = workbook.worksheets[0];
      return ws ? parseTbankXlsx(ws) : [];
    }
    return format === 'html' ? parseBrokerHtmlReport(content) : parseCsv(content);
  }

  /** Существующие ключи дедупликации (чтобы не задвоить при повторной загрузке) */
  private existingDedupeKeys(): Set<string> {
    const ops = this.db.select().from(operations).all();
    return new Set(
      ops.map((o) =>
        makeDedupeKey({
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
        }),
      ),
    );
  }

  /** Предпросмотр (dry-run): распознаёт строки, но ничего не пишет */
  async preview(content: string, opts: ImportOptions = {}): Promise<PreviewResult> {
    const rawRows: RawRow[] = await this.parseFile(content, opts.format);
    const resolvers = this.buildResolvers({
      systemId: opts.systemId,
      portfolioId: opts.portfolioId,
      tickerSystemOverrides: opts.tickerSystemOverrides,
    });
    const existing = this.existingDedupeKeys();
    const seenInBatch = new Set<string>();

    const rows: PreviewRow[] = rawRows.map((raw) => {
      const res = normalizeRow(raw, resolvers);
      if ('error' in res) {
        return { confidence: 'error', reason: res.error };
      }
      // дедуп против БД и внутри самого файла
      if (existing.has(res.dedupeKey) || seenInBatch.has(res.dedupeKey)) {
        return {
          operation: res.operation,
          confidence: 'duplicate',
          reason: 'Уже есть в базе',
          accountRef: raw.accountRef,
          ticker: raw.ticker,
          systemUncertain: res.systemUncertain,
        };
      }
      seenInBatch.add(res.dedupeKey);
      return {
        operation: res.operation,
        confidence: res.confidence,
        reason: res.reason,
        accountRef: raw.accountRef,
        ticker: raw.ticker,
        systemUncertain: res.systemUncertain,
      };
    });

    const summary = {
      total: rows.length,
      ok: rows.filter((r) => r.confidence === 'ok').length,
      warn: rows.filter((r) => r.confidence === 'warn').length,
      error: rows.filter((r) => r.confidence === 'error').length,
      duplicate: rows.filter((r) => r.confidence === 'duplicate').length,
    };
    return { rows, summary };
  }

  /** Импорт: сохраняет все ok/warn строки (не error, не duplicate) под общим batchId */
  async commit(content: string, opts: ImportOptions = {}): Promise<{ batchId: string; imported: number }> {
    const preview = await this.preview(content, opts);
    const batchId = randomUUID();
    let imported = 0;
    const learnedRefs = new Set<string>();

    for (const row of preview.rows) {
      if (!row.operation) continue;
      if (row.confidence === 'error' || row.confidence === 'duplicate') continue;

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
          importBatchId: batchId,
        })
        .run();
      imported++;

      if (row.accountRef && !learnedRefs.has(row.accountRef)) {
        learnedRefs.add(row.accountRef);
        this.learnAccountMapping(row.accountRef, row.operation.portfolioId);
      }
    }

    return { batchId, imported };
  }

  /** Откат импорта: удаляет все операции указанной загрузки */
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
