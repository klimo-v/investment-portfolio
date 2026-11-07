import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  ANNOTATION_PARSERS,
  matchAnnotations,
  type AnnotationMatch,
  type AnnotationRow,
  type MatchableOperation,
  type Operation,
} from '@core';
import { instruments, operationAnnotations, operations } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';

/** Одна строка предпросмотра: сопоставлена с операцией или отклонена с причиной */
export interface AnnotationPreviewRow {
  /** номер строки файла (0 — ошибка уровня файла, например нет колонок) */
  line: number;
  status: 'matched' | 'error';
  reason?: string;
  brokerRef?: string;
  date?: string;
  ticker?: string;
  side?: 'Buy' | 'Sell';
  quantity?: string;
  price?: string;
  tag?: string | null;
  signalPrice?: string | null;
  /** для matched — операция журнала, к которой привяжется аннотация */
  operationId?: string;
}

export interface AnnotationPreview {
  rows: AnnotationPreviewRow[];
  summary: { total: number; matched: number; error: number };
}

export interface AnnotationInput {
  content: string;
  /** идентификатор парсера (формат выгрузки); по умолчанию quik-trades */
  format?: string;
}

/**
 * Импорт аннотаций исполнения (CSV терминала): предпросмотр → подтверждение, как у
 * основного импорта. Привязывает тег и сигнальную цену к УЖЕ существующим операциям
 * журнала и ничего в самих операциях не меняет (комиссии, цены, количество — только из
 * отчёта брокера). Парсер выбирается по формату (Strategy/Factory, OCP).
 */
@Injectable()
export class AnnotationImportService {
  constructor(@Inject(DB) private readonly db: BetterSQLite3Database) {}

  /** Предпросмотр — dry-run, ничего не пишет */
  preview(input: AnnotationInput): AnnotationPreview {
    const format = input.format ?? 'quik-trades';
    const parser = ANNOTATION_PARSERS[format];
    if (!parser) throw new BadRequestException(`Неизвестный формат выгрузки: "${format}"`);

    const { rows, errors } = parser.parse(input.content ?? '');
    const matches = matchAnnotations(rows, this.matchableOperations());

    const out: AnnotationPreviewRow[] = [
      ...errors.map((e): AnnotationPreviewRow => ({ line: e.line, status: 'error', reason: e.reason })),
      ...matches.map((m) => this.toPreviewRow(m)),
    ].sort((a, b) => a.line - b.line);

    const matched = out.filter((r) => r.status === 'matched').length;
    return { rows: out, summary: { total: out.length, matched, error: out.length - matched } };
  }

  /**
   * Сохраняет аннотации сопоставленных строк (upsert по операции — повторная загрузка
   * того же файла идемпотентна). Несопоставленные возвращаются в `skipped` с причиной —
   * не теряются молча.
   */
  commit(input: AnnotationInput): { saved: number; skipped: AnnotationPreviewRow[] } {
    const format = input.format ?? 'quik-trades';
    const preview = this.preview(input);
    const importedAt = new Date().toISOString();

    let saved = 0;
    for (const r of preview.rows) {
      if (r.status !== 'matched' || !r.operationId) continue;
      const values = { tag: r.tag ?? null, signalPrice: r.signalPrice ?? null, source: format, importedAt };
      this.db
        .insert(operationAnnotations)
        .values({ operationId: r.operationId, ...values })
        .onConflictDoUpdate({ target: operationAnnotations.operationId, set: values })
        .run();
      saved++;
    }
    return { saved, skipped: preview.rows.filter((r) => r.status === 'error') };
  }

  private matchableOperations(): MatchableOperation[] {
    const tickerById = new Map(this.db.select().from(instruments).all().map((i) => [i.id, i.ticker]));
    return this.db
      .select()
      .from(operations)
      .all()
      .filter((o) => o.brokerRef)
      .map((o) => ({
        operation: {
          id: o.id,
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
          brokerRef: o.brokerRef,
        },
        ticker: o.instrumentId ? (tickerById.get(o.instrumentId) ?? null) : null,
      }));
  }

  private toPreviewRow(m: AnnotationMatch): AnnotationPreviewRow {
    const r: AnnotationRow = m.row;
    return {
      line: r.line,
      status: m.ok ? 'matched' : 'error',
      reason: m.ok ? undefined : m.reason,
      brokerRef: r.brokerRef,
      date: r.date,
      ticker: r.ticker,
      side: r.side,
      quantity: r.quantity,
      price: r.price,
      tag: r.tag,
      signalPrice: r.signalPrice,
      operationId: m.ok ? m.operationId : undefined,
    };
  }
}
