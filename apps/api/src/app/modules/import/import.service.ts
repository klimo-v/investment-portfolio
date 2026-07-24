import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { normalizeRow, makeDedupeKey, parseBrokerHtmlReport, type RawRow, type Operation } from '@core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { operations, systems, portfolios, instruments, type InstrumentRow } from '../../../db/schema';
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
  /** Id уже распарсенного файла — передать в следующий preview()/commit() вместо content (см. ImportInput) */
  uploadId: string;
}

/** Формат исходного файла (Factory: новый брокер = новый парсер, OCP) */
export type ImportFormat = 'csv' | 'html' | 'xlsx';

/** ISIN: 2 буквы страны + 9 букв/цифр + 1 цифра-контроль (12 символов) */
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

const INSTRUMENT_TYPES = new Set(['Stock', 'Bond', 'ETF', 'Currency', 'Crypto', 'Cash']);

/** Точное совпадение имени после схлопывания пробелов/регистра — намеренно без
 * нечёткого фаззи-матчинга, чтобы не склеить случайно два разных инструмента */
function normalizeName(name?: string | null): string | null {
  const n = (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return n || null;
}

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
  constructor(@Inject(DB) private readonly db: BetterSQLite3Database) {}

  /**
   * Кэш уже распарсенных файлов на время правки батч-разметки/тикер-выбора
   * (см. ImportInput). Однопользовательское локальное приложение — простой
   * Map с ограничением размера вместо TTL/внешнего кэша (YAGNI).
   */
  private readonly uploads = new Map<string, RawRow[]>();
  private static readonly MAX_UPLOADS = 20;

  /** Строки файла: из кэша по uploadId либо свежий разбор content (Factory: формат → парсер) */
  private async resolveRawRows(input: ImportInput): Promise<{ rows: RawRow[]; uploadId: string }> {
    if (input.uploadId) {
      const cached = this.uploads.get(input.uploadId);
      if (cached) return { rows: cached, uploadId: input.uploadId };
      if (!input.content) {
        throw new BadRequestException('Файл больше не в кэше — выберите его заново');
      }
    }
    const rows = await this.parseFile(input.content ?? '', input.format);
    const uploadId = input.uploadId ?? randomUUID();
    this.uploads.set(uploadId, rows);
    if (this.uploads.size > ImportService.MAX_UPLOADS) {
      const oldest = this.uploads.keys().next().value;
      if (oldest) this.uploads.delete(oldest);
    }
    return { rows, uploadId };
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
  ) {
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
    const instrumentByName = new Map(
      instrumentRows
        .filter((i) => i.name)
        .map((i) => [normalizeName(i.name) as string, i.id]),
    );
    // кросс-ссылка «имя бумаги → id» из ЭТОГО ЖЕ импорта: брокер может репортить
    // один и тот же актив то тикером (биржа), то ISIN (внебиржевая сделка/выплата,
    // см. docs/04-roadmap.md §3.1-подобный случай) — если в файле есть строка,
    // где тикер уже резолвится, а имя совпадает со строкой, где резолвится только
    // ISIN, подхватываем тот же инструмент вместо неудачного резолва
    const batchNameToInstrument = new Map<string, string>();
    for (const raw of rawRows) {
      const t = raw.ticker?.toLowerCase();
      const hit = t ? (instrumentByTicker.get(t) ?? instrumentByIsin.get(t)) : undefined;
      const name = normalizeName(raw.name);
      if (hit && name && !batchNameToInstrument.has(name)) batchNameToInstrument.set(name, hit);
    }

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
      resolveInstrument: (ticker?: string, name?: string) => {
        if (ticker) {
          const hit = instrumentByTicker.get(ticker.toLowerCase()) ?? instrumentByIsin.get(ticker.toLowerCase());
          if (hit) return hit;
        }
        const n = normalizeName(name);
        if (n) {
          const hit = batchNameToInstrument.get(n) ?? instrumentByName.get(n);
          if (hit) return hit;
        }
        return null;
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
   * Авто-обучение справочника инструментов новыми тикерами/ISIN из отчёта
   * (вызывается только из commit(), preview() остаётся dry-run без записи в БД).
   *
   * Резолв в 3 шага, чтобы не создать дубль-инструмент, когда брокер репортит
   * ОДИН И ТОТ ЖЕ актив то тикером (биржа), то ISIN (внебиржевая сделка/выплата
   * — реальный случай, найденный на LKOH/SBER/X5 в отчётах Т-Банка):
   *   1. Тикер/ISIN уже есть в справочнике → это тот же инструмент, донаучиваем
   *      недостающие поля (isin/name), НЕ создаём новую строку.
   *   2. Не резолвится по тикеру/ISIN, но имя бумаги совпадает с уже известным
   *      инструментом (из справочника или из другой строки этого же файла) →
   *      тот же случай, донаучиваем isin на существующую строку.
   *   3. Ни тикер/ISIN, ни имя нигде не найдены → это ДЕЙСТВИТЕЛЬНО новый
   *      инструмент, создаём новую строку. marketSource оставляем 'manual' —
   *      автоматически считать любой новый код торгуемым на MOEX небезопасно,
   *      пользователь может переключить вручную, когда убедится, что это так
   *      (см. docs/04-roadmap.md §3.1).
   */
  private ensureInstruments(rawRows: RawRow[]): void {
    const rows = this.db.select().from(instruments).all();
    const byTicker = new Map(rows.map((i) => [i.ticker.toLowerCase(), i]));
    const byIsin = new Map(rows.filter((i) => i.isin).map((i) => [(i.isin as string).toLowerCase(), i]));
    const byName = new Map(rows.filter((i) => i.name).map((i) => [normalizeName(i.name) as string, i]));
    const createdInBatch = new Set<string>();

    const rememberInstrument = (inst: InstrumentRow): void => {
      byTicker.set(inst.ticker.toLowerCase(), inst);
      if (inst.isin) byIsin.set(inst.isin.toLowerCase(), inst);
      if (inst.name) byName.set(normalizeName(inst.name) as string, inst);
    };

    // предварительный проход по ВСЕМУ файлу: если тикер/ISIN какой-то строки уже
    // резолвится, запоминаем её имя → инструмент. Без этого прохода результат
    // зависел бы от ПОРЯДКА строк в файле — брокер может расположить ISIN-код
    // одного и того же актива РАНЬШЕ его же биржевых сделок с обычным тикером
    // (реальный случай: ЛУКОЙЛ по ISIN на внебирже в файле стоял перед сделками
    // по тикеру LKOH), и тогда имя ещё не «выучено», когда до этой строки дошла
    // бы очередь — резолв по имени ниже не сработал бы и создал бы дубль-инструмент.
    for (const raw of rawRows) {
      if (!raw.ticker) continue;
      const t = raw.ticker.toLowerCase();
      const hit = byTicker.get(t) ?? byIsin.get(t);
      const name = normalizeName(raw.name);
      if (hit && name && !byName.has(name)) byName.set(name, hit);
    }

    for (const raw of rawRows) {
      if (!raw.ticker) continue;
      const t = raw.ticker.toLowerCase();
      const isinLike = ISIN_RE.test(raw.ticker) ? raw.ticker : null;
      const name = normalizeName(raw.name);
      const existing = byTicker.get(t) ?? byIsin.get(t) ?? (name ? byName.get(name) : undefined);

      if (existing) {
        // уже резолвится (по тикеру/ISIN/имени) — донаучиваем недостающие поля,
        // существующие значения никогда не перезаписываем молча
        const patch: Partial<Pick<InstrumentRow, 'isin' | 'name'>> = {};
        if (!existing.isin && isinLike) patch.isin = isinLike;
        if (!existing.name && raw.name) patch.name = raw.name.trim();
        if (Object.keys(patch).length > 0) {
          this.db.update(instruments).set(patch).where(eq(instruments.id, existing.id)).run();
          rememberInstrument({ ...existing, ...patch });
        } else {
          rememberInstrument(existing);
        }
        continue;
      }

      // совсем новый инструмент — ни тикер/ISIN, ни имя нигде не найдены
      if (createdInBatch.has(t)) continue;
      createdInBatch.add(t);
      const type = INSTRUMENT_TYPES.has(raw.instrumentType ?? '')
        ? (raw.instrumentType as InstrumentRow['type'])
        : 'Stock';
      const created: InstrumentRow = {
        id: raw.ticker,
        ticker: raw.ticker,
        type,
        currency: raw.currency?.trim() || 'RUB',
        isin: isinLike,
        name: raw.name?.trim() || null,
        marketSource: 'manual',
      };
      this.db.insert(instruments).values(created).onConflictDoNothing().run();
      rememberInstrument(created);
    }
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
      const buf = Buffer.from(content, 'base64') as any;
      // ignoreNodes: реальный отчёт Т-Банка (1200+ строк) разбирался ~30 секунд —
      // весь разбор уходил на парсинг диапазонов mergeCells; сами значения ячеек
      // хранятся отдельно от merge-разметки, поэтому её пропуск не меняет
      // результат (проверено побайтовым сравнением), а разбор занимает ~200мс.
      await workbook.xlsx.load(buf, { ignoreNodes: ['mergeCells'] });
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
  async preview(input: ImportInput): Promise<PreviewResult> {
    const { rows: rawRows, uploadId } = await this.resolveRawRows(input);
    const resolvers = this.buildResolvers(rawRows, {
      systemId: input.systemId,
      portfolioId: input.portfolioId,
      tickerSystemOverrides: input.tickerSystemOverrides,
    });
    const existing = this.existingDedupeKeys();
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
      const ticker = res.operation.instrumentId ?? raw.ticker;
      // дедуп против БД и внутри самого файла
      if (existing.has(res.dedupeKey) || seenInBatch.has(res.dedupeKey)) {
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
    };
    return { rows, summary, uploadId };
  }

  /** Импорт: сохраняет все ok/warn строки (не error, не duplicate) под общим batchId */
  async commit(input: ImportInput): Promise<{ batchId: string; imported: number }> {
    // авто-обучение справочника инструментов ДО резолва — preview() внутри
    // подхватит уже созданные/донаученные строки при обычном поиске по тикеру/ISIN
    const { rows: rawRows } = await this.resolveRawRows(input);
    this.ensureInstruments(rawRows);

    const preview = await this.preview(input);
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

    this.uploads.delete(preview.uploadId);
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
