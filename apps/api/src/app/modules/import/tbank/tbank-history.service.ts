import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Decimal from 'decimal.js';
import {
  identityKey, normalizeRawRows, rowCodes,
  type RawRow, type TbankHistoryPreview, type TbankHistoryRequest,
  type TbankHistoryResult, type TbankHistoryRow,
} from '@core';
import { dataGate } from '../../../../data-management/data-gate';
import { loadIdentityIndex } from '../../../../db/instrument-identifiers-store';
import { operations, portfolios, type OperationRow } from '../../../../db/schema';
import { DB } from '../../../db/drizzle.module';
import { TbankSyncService } from './tbank-sync.service';

interface PreviewEntry {
  request: TbankHistoryRequest;
  rows: RawRow[];
  preview: TbankHistoryPreview;
  generation: typeof dataGate.generation;
}

@Injectable()
export class TbankHistoryService {
  private readonly previews = new Map<string, PreviewEntry>();

  constructor(
    @Inject(DB) private readonly db: BetterSQLite3Database,
    private readonly sync: TbankSyncService,
  ) {}

  async preview(request: TbankHistoryRequest): Promise<TbankHistoryPreview> {
    const previewId = randomUUID();
    const generation = dataGate.generation;
    const bindingIssue = this.bindingIssue(this.db, request);
    if (bindingIssue) return this.summarize(previewId, [], bindingIssue);

    const rows = normalizeRawRows(await this.sync.fetchRawRows(request.accountId, request.from, request.to))
      .filter((row) => row.instrumentType === 'Bond' && (row.tradeType === 'buy' || row.tradeType === 'sell') &&
        row.date >= request.from && row.date <= request.to);
    if (generation !== dataGate.generation) throw new ConflictException('Профиль изменился. Повторите предпросмотр.');
    const preview = this.plan(this.db, request, rows, previewId);
    if (preview.bindingIssue) return preview;

    this.previews.set(previewId, { request, rows, preview, generation });
    if (this.previews.size > 20) {
      const oldest = this.previews.keys().next().value;
      if (oldest) this.previews.delete(oldest);
    }
    return preview;
  }

  commit(previewId: string): TbankHistoryResult {
    const entry = this.previews.get(previewId);
    if (!entry || entry.generation !== dataGate.generation) {
      throw new BadRequestException('Предпросмотр устарел. Загрузите операции заново.');
    }
    return this.db.transaction((tx) => {
      const current = this.plan(tx, entry.request, entry.rows, previewId);
      if (current.bindingIssue) throw new ConflictException(current.bindingIssue);

      const updates = current.rows.filter((row) => row.status === 'update');
      if (!updates.length) return { imported: 0, updated: 0, preview: current };
      if (JSON.stringify(current.rows) !== JSON.stringify(entry.preview.rows)) {
        throw new ConflictException('Журнал изменился после предпросмотра. Загрузите операции заново.');
      }

      for (const row of updates) {
        tx.update(operations).set({
          grossTradeAmount: row.amount,
          grossTradeAmountSource: row.source,
        }).where(eq(operations.id, row.operationId!)).run();
      }
      return {
        imported: 0,
        updated: updates.length,
        preview: this.plan(tx, entry.request, entry.rows, previewId),
      };
    }, { behavior: 'immediate' });
  }

  private bindingIssue(db: BetterSQLite3Database, request: TbankHistoryRequest): string | undefined {
    const portfolio = db.select().from(portfolios).where(eq(portfolios.id, request.portfolioId)).get();
    if (!portfolio) return 'Выбранный портфель не найден.';
    if (!portfolio.accountRef) return 'У портфеля нет подтверждённой привязки к брокерскому счёту.';
    return portfolio.accountRef !== request.accountId
      ? 'Выбранный счёт Т‑Банка отличается от привязки портфеля. Обновление заблокировано.'
      : undefined;
  }

  private plan(
    db: BetterSQLite3Database, request: TbankHistoryRequest, rawRows: RawRow[], previewId: string,
  ): TbankHistoryPreview {
    const bindingIssue = this.bindingIssue(db, request);
    if (bindingIssue) return this.summarize(previewId, [], bindingIssue);

    const stored = db.select().from(operations).where(and(
      eq(operations.portfolioId, request.portfolioId),
      inArray(operations.operationType, ['Buy', 'Sell']),
    )).orderBy(operations.date, operations.id).all();
    const byNumber = new Map<string, OperationRow[]>();
    for (const op of stored) {
      if (!op.brokerRef) continue;
      const matches = byNumber.get(op.brokerRef) ?? [];
      matches.push(op);
      byNumber.set(op.brokerRef, matches);
    }

    const occurrences = new Map<string, number>();
    for (const row of rawRows) {
      if (row.executionRef) occurrences.set(row.executionRef, (occurrences.get(row.executionRef) ?? 0) + 1);
    }

    const identity = loadIdentityIndex(db);
    const rows = rawRows.map((raw): TbankHistoryRow => {
      const base = {
        date: raw.date, executionRef: raw.executionRef, ticker: identityKey(raw),
        amount: raw.grossTradeAmount, source: raw.grossTradeAmountSource,
      };
      const issue = raw.grossTradeAmountIssue ?? raw.skipReason;
      if (raw.accountRef !== request.accountId) return { ...base, status: 'conflict', reason: 'Строка относится к другому счёту.' };
      if (!raw.executionRef) return { ...base, status: 'unknown', reason: 'В API нет биржевого номера исполнения.' };
      const matches = byNumber.get(raw.executionRef) ?? [];
      if (matches.length > 1 || occurrences.get(raw.executionRef) !== 1) {
        return { ...base, status: 'conflict', reason: 'Биржевой номер повторяется у брокера или в журнале портфеля.' };
      }
      const op = matches[0];
      if (!op) return { ...base, status: 'unmatched', reason: ['Сделка отсутствует в журнале выбранного портфеля за этот период.', issue].filter(Boolean).join(' ') };

      const candidate = { ...base, operationId: op.id, previousAmount: op.grossTradeAmount, previousSource: op.grossTradeAmountSource };
      const instrumentMatches = new Set(rowCodes(raw)
        .filter(({ scheme }) => scheme !== 'name' && scheme !== 'ticker')
        .flatMap(({ scheme, value }) => identity.find(scheme, value) ?? []));
      if (!op.instrumentId || instrumentMatches.size !== 1 || !instrumentMatches.has(op.instrumentId) ||
          identity.instrument(op.instrumentId)?.type !== 'Bond' || op.date !== raw.date ||
          op.operationType.toLowerCase() !== raw.tradeType || op.currency.toUpperCase() !== raw.currency?.toUpperCase() ||
          !raw.quantity || !new Decimal(op.quantity).eq(raw.quantity)) {
        return { ...candidate, status: 'conflict', reason: 'Не совпали дата, инструмент, сторона, количество или валюта сделки.' };
      }

      if (issue || !base.amount || !base.source) {
        return { ...candidate, status: 'unknown', reason: issue ?? 'Сумма исполнения не подтверждена.' };
      }
      if (op.currency.toUpperCase() === 'RUB' && !new Decimal(op.fxRate).eq(1)) {
        return { ...candidate, status: 'conflict', reason: 'В журнале курс рублёвой сделки отличается от 1.' };
      }
      const sameAmount = op.grossTradeAmount !== null && new Decimal(op.grossTradeAmount).eq(base.amount);
      if (op.grossTradeAmount !== null && !sameAmount) {
        return { ...candidate, status: 'conflict', reason: 'Новая сумма расходится с сохранённой суммой исполнения.' };
      }
      // Платёж одного исполнения сильнее суммы, восстановленной из полей группы.
      if (sameAmount && (op.grossTradeAmountSource === 'tbank-payment' || op.grossTradeAmountSource === base.source)) {
        return { ...candidate, source: op.grossTradeAmountSource, status: 'matched' };
      }
      return { ...candidate, status: 'update' };
    });

    for (const op of stored) {
      if (op.date < request.from || op.date > request.to || !op.instrumentId ||
          identity.instrument(op.instrumentId)?.type !== 'Bond' || (op.brokerRef && occurrences.has(op.brokerRef))) continue;
      rows.push({
        date: op.date,
        executionRef: op.brokerRef ?? undefined,
        ticker: op.instrumentId ? identity.instrument(op.instrumentId)?.ticker : undefined,
        operationId: op.id,
        status: op.brokerRef ? 'unmatched' : 'unknown',
        reason: op.brokerRef ? 'В API за этот период нет исполнения с таким номером.' : 'В журнале отсутствует номер исполнения.',
      });
    }
    return this.summarize(previewId, rows);
  }

  private summarize(previewId: string, rows: TbankHistoryRow[], bindingIssue?: string): TbankHistoryPreview {
    const summary = { update: 0, matched: 0, unmatched: 0, conflict: 0, unknown: 0 };
    for (const row of rows) summary[row.status]++;
    return { previewId, rows, summary, bindingIssue };
  }
}
