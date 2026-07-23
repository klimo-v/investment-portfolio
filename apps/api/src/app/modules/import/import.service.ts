import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  normalizeRow,
  makeDedupeKey,
  type RawRow,
  type Operation,
} from '@core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { operations, systems, portfolios, instruments } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { parseCsv } from './csv-parser';

/** Одна строка предпросмотра импорта */
export interface PreviewRow {
  operation?: Operation;
  confidence: 'ok' | 'warn' | 'error' | 'duplicate';
  reason?: string;
}

export interface PreviewResult {
  rows: PreviewRow[];
  summary: { total: number; ok: number; warn: number; error: number; duplicate: number };
}

/**
 * Сервис импорта (Facade). Конвейер: CSV → RawRow → нормализация/классификация
 * (движок @core) → дедупликация → предпросмотр/сохранение (docs/02-data-model.md §6).
 */
@Injectable()
export class ImportService {
  constructor(@Inject(DB) private readonly db: BetterSQLite3Database) {}

  /** Резолверы имён из справочников в id (сопоставление по имени/тикеру) */
  private buildResolvers() {
    const systemRows = this.db.select().from(systems).all();
    const portfolioRows = this.db.select().from(portfolios).all();
    const instrumentRows = this.db.select().from(instruments).all();

    const systemByName = new Map(systemRows.map((s) => [s.name.toLowerCase(), s.id]));
    const portfolioByBroker = new Map(portfolioRows.map((p) => [p.broker.toLowerCase(), p.id]));
    const portfolioByName = new Map(portfolioRows.map((p) => [p.name.toLowerCase(), p.id]));
    const instrumentByTicker = new Map(instrumentRows.map((i) => [i.ticker.toLowerCase(), i.id]));

    return {
      resolveSystem: (name?: string) =>
        name ? (systemByName.get(name.toLowerCase()) ?? null) : null,
      resolvePortfolio: (broker?: string) =>
        broker
          ? (portfolioByBroker.get(broker.toLowerCase()) ??
            portfolioByName.get(broker.toLowerCase()) ??
            null)
          : null,
      resolveInstrument: (ticker?: string) =>
        ticker ? (instrumentByTicker.get(ticker.toLowerCase()) ?? null) : null,
    };
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
        }),
      ),
    );
  }

  /** Предпросмотр (dry-run): распознаёт строки, но ничего не пишет */
  preview(csvContent: string): PreviewResult {
    const rawRows: RawRow[] = parseCsv(csvContent);
    const resolvers = this.buildResolvers();
    const existing = this.existingDedupeKeys();
    const seenInBatch = new Set<string>();

    const rows: PreviewRow[] = rawRows.map((raw) => {
      const res = normalizeRow(raw, resolvers);
      if ('error' in res) {
        return { confidence: 'error', reason: res.error };
      }
      // дедуп против БД и внутри самого файла
      if (existing.has(res.dedupeKey) || seenInBatch.has(res.dedupeKey)) {
        return { operation: res.operation, confidence: 'duplicate', reason: 'Уже есть в базе' };
      }
      seenInBatch.add(res.dedupeKey);
      return { operation: res.operation, confidence: res.confidence, reason: res.reason };
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
  commit(csvContent: string): { batchId: string; imported: number } {
    const preview = this.preview(csvContent);
    const batchId = randomUUID();
    let imported = 0;

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
          importBatchId: batchId,
        })
        .run();
      imported++;
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
