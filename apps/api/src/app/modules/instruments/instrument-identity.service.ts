import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  findPossibleDuplicates,
  identityConflicts,
  MergePayloadV1,
  SplitPayloadV1,
  SplitRequestSchema,
  planInstrumentSplit,
  type Operation,
  type SplitPayload,
  type SplitPlan,
  parseMergePayload,
  mergeChecks,
  type MergePayload,
  type MergeCheckInstrument,
  type MergeChecks,
  isValidIsin,
  normalizeCode,
  normalizeName,
  planInstrumentIdentities,
  type IdentityChoice,
  type IdentityEntry,
  type IdentityPlan,
  type InstrumentIdentifiersDto,
  type PossibleDuplicate,
  type RawRow,
} from '@core';
import { insertIdentifier, loadIdentityIndex } from '../../../db/instrument-identifiers-store';
import { recordPrice } from '../../../db/price-history-store';
import {
  futuresSettlements,
  instrumentHistory,
  instrumentIdentifiers,
  instruments,
  operations,
  priceHistory,
  quotes,
} from '../../../db/schema';
import { DB } from '../../db/drizzle.module';

/** Предпросмотр слияния: проверки и последствия */
export interface MergePreviewDto {
  source: { id: string; ticker: string; name: string | null };
  target: { id: string; ticker: string; name: string | null };
  blockers: MergeChecks['blockers'];
  warnings: MergeChecks['warnings'];
  consequences: { operations: number; prices: number; pricesDiscarded: number; codes: number };
}

/** Пара возможных дублей с предложенным направлением слияния (source → target) */
export interface PossibleDuplicateDto {
  sourceId: string;
  sourceTicker: string;
  sourceName: string | null;
  targetId: string;
  targetTicker: string;
  targetName: string | null;
  type: string;
  reason: string;
  deterministic: boolean;
}

/**
 * Единственный, кто пишет в `instrument_identifiers` (docs/02-data-model.md,
 * «Идентичность инструментов»). Правила резолва — чистые функции в `@core`; здесь они
 * только применяются к БД:
 *  - `plan` — dry-run резолва строк импорта (preview не пишет ничего);
 *  - `apply` — записывает план (новые инструменты, идентификаторы, донаученные поля)
 *    одной транзакцией;
 *  - `merge` — ручное «Слить»: то же решение, что и выбор в предпросмотре, но после факта.
 */
@Injectable()
export class InstrumentIdentityService {
  constructor(@Inject(DB) private readonly db: BetterSQLite3Database) {}

  /** План резолва строк (нормализованных) без записи в БД */
  plan(rows: RawRow[], choices?: Record<string, IdentityChoice>): IdentityPlan {
    return planInstrumentIdentities(rows, loadIdentityIndex(this.db), choices);
  }

  /** Применить план: новые инструменты и их идентификаторы, связи, пустые isin/name */
  apply(plan: IdentityPlan): void {
    if (plan.created.length === 0 && plan.links.length === 0 && plan.patches.length === 0) return;
    this.db.transaction((tx) => {
      for (const c of plan.created) {
        // коллизия id здесь невозможна (планировщик её отсекает); если всё же случилась —
        // транзакция откатится, а не привяжет строку к чужому инструменту молча
        tx.insert(instruments)
          .values({ id: c.id, ticker: c.ticker, type: c.type as never, currency: c.currency, isin: c.isin, name: c.name, marketSource: 'manual' })
          .run();
        for (const e of c.entries) insertIdentifier(tx, e);
      }
      for (const e of plan.links) insertIdentifier(tx, e);
      for (const p of plan.patches) {
        const [cur] = tx.select().from(instruments).where(eq(instruments.id, p.instrumentId)).all();
        if (!cur) continue;
        const set: { isin?: string; name?: string } = {};
        if (!cur.isin && p.isin) set.isin = p.isin;
        if (!cur.name && p.name) set.name = p.name;
        if (Object.keys(set).length > 0) tx.update(instruments).set(set).where(eq(instruments.id, p.instrumentId)).run();
      }
    });
  }

  /** Инструмент по тикеру (после нормализации) — для вспомогательных данных отчёта (марки, вариационная маржа) */
  findByTicker(ticker: string): string | undefined {
    const code = normalizeCode(ticker);
    return code ? loadIdentityIndex(this.db).find('ticker', code) : undefined;
  }

  /**
   * Список «Возможные дубли» — те же эвристики, что и подсказки в предпросмотре. Для
   * каждой пары предлагается направление слияния: целью становится «более каноничный»
   * инструмент (нормализованный тикер, валидный ISIN, рыночный источник цены).
   */
  possibleDuplicates(): PossibleDuplicateDto[] {
    const rows = new Map(this.db.select().from(instruments).all().map((i) => [i.id, i]));
    const score = (id: string): number => {
      const i = rows.get(id);
      if (!i) return 0;
      return (
        Number(i.ticker === normalizeCode(i.ticker)) +
        Number(isValidIsin(i.ticker) || isValidIsin(i.isin)) +
        Number(i.marketSource !== 'manual')
      );
    };
    return findPossibleDuplicates(loadIdentityIndex(this.db).instruments()).map((d: PossibleDuplicate) => {
      const [target, source] = score(d.b.id) > score(d.a.id) ? [d.b, d.a] : [d.a, d.b];
      return {
        sourceId: source.id,
        sourceTicker: source.ticker,
        sourceName: source.name ?? null,
        targetId: target.id,
        targetTicker: target.ticker,
        targetName: target.name ?? null,
        type: source.type,
        reason: d.reason,
        deterministic: d.deterministic,
      };
    });
  }

  /** «Привязанные коды» одного инструмента + пометка identityConflicts (только чтение) */
  identifiers(instrumentId: string): InstrumentIdentifiersDto {
    const [instrument] = this.db.select().from(instruments).where(eq(instruments.id, instrumentId)).all();
    if (!instrument) throw new NotFoundException(`Инструмент не найден: ${instrumentId}`);
    return this.toIdentifiersDto(instrument, this.entriesOf(instrumentId), this.mergesOf(instrumentId));
  }

  /**
   * Инструменты, у которых есть слитые коды (origin 'merge') или подозрительный набор, — для
   * виджета «Привязанные коды». Остальные инструменты в нём не нужны: без слияний у них один
   * набор кодов от импорта.
   */
  mergedIdentifiers(): InstrumentIdentifiersDto[] {
    const byInstrument = new Map<string, (typeof instrumentIdentifiers.$inferSelect)[]>();
    for (const r of this.db.select().from(instrumentIdentifiers).all()) {
      byInstrument.set(r.instrumentId, [...(byInstrument.get(r.instrumentId) ?? []), r]);
    }
    return this.db
      .select()
      .from(instruments)
      .all()
      .flatMap((i) => {
        const entries = byInstrument.get(i.id) ?? [];
        const dto = this.toIdentifiersDto(i, entries, this.mergesOf(i.id));
        return entries.some((e) => e.origin === 'merge') || dto.conflicting || dto.merges.length > 0 ? [dto] : [];
      })
      .sort((a, b) => Number(b.conflicting) - Number(a.conflicting) || a.ticker.localeCompare(b.ticker));
  }

  private entriesOf(instrumentId: string) {
    return this.db.select().from(instrumentIdentifiers).where(eq(instrumentIdentifiers.instrumentId, instrumentId)).all();
  }

  private toIdentifiersDto(
    instrument: { id: string; ticker: string; name: string | null },
    entries: { scheme: string; value: string; origin: string; createdAt: string }[],
    merges: InstrumentIdentifiersDto['merges'],
  ): InstrumentIdentifiersDto {
    const conflict = identityConflicts(entries);
    return {
      instrumentId: instrument.id,
      ticker: instrument.ticker,
      name: instrument.name ?? null,
      entries: entries
        .map((e) => ({ scheme: e.scheme, value: e.value, origin: e.origin, createdAt: e.createdAt }) as InstrumentIdentifiersDto['entries'][number])
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.scheme.localeCompare(b.scheme) || a.value.localeCompare(b.value)),
      conflicting: conflict.conflicting,
      tickers: conflict.tickers,
      merges,
    };
  }

  /**
   * Слияния из журнала, давшие этот инструмент: прямые (target = он) и цепочкой (источник
   * прежнего слияния сам был целью более раннего). Слияния до включения журнала сюда не попадают.
   */
  private mergesOf(instrumentId: string): InstrumentIdentifiersDto['merges'] {
    const rows = this.db.select().from(instrumentHistory).where(eq(instrumentHistory.kind, 'merge')).all();
    const reach = new Set([instrumentId]);
    const found = new Map<string, (typeof rows)[number]>();
    for (let grew = true; grew; ) {
      grew = false;
      for (const r of rows) {
        if (reach.has(r.targetId) && !found.has(r.id)) {
          found.set(r.id, r);
          reach.add(r.sourceId);
          grew = true;
        }
      }
    }
    // порядок вставки в журнал (rowid), а не `at`: время слияния — с точностью до секунды
    return rows
      .filter((r) => found.has(r.id))
      .map((r) => {
        const p = parseMergePayload(r.payload);
        return {
          id: r.id,
          at: r.at,
          sourceId: r.sourceId,
          sourceTicker: p.source.ticker,
          sourceName: p.source.name,
          undone: r.undoneAt !== null,
        };
      });
  }

  /** Предпросмотр слияния: проверки (блокировки/предупреждения) и последствия — без записи */
  mergePreview(sourceId: string, targetId: string): MergePreviewDto {
    const { source, target } = this.loadPair(sourceId, targetId);
    const checks = this.checksFor(source, target);
    const count = (table: typeof operations | typeof priceHistory | typeof instrumentIdentifiers, col: unknown) =>
      this.db.select({ n: sql<number>`count(*)` }).from(table).where(eq(col as never, sourceId)).get()?.n ?? 0;
    return {
      source: { id: source.id, ticker: source.ticker, name: source.name ?? null },
      target: { id: target.id, ticker: target.ticker, name: target.name ?? null },
      blockers: checks.blockers,
      warnings: checks.warnings,
      consequences: {
        operations: count(operations, operations.instrumentId),
        prices: source.currency === target.currency ? count(priceHistory, priceHistory.instrumentId) : 0,
        pricesDiscarded: source.currency === target.currency ? 0 : count(priceHistory, priceHistory.instrumentId),
        codes: count(instrumentIdentifiers, instrumentIdentifiers.instrumentId),
      },
    };
  }

  private loadPair(sourceId: string, targetId: string) {
    if (sourceId === targetId) throw new BadRequestException('Нельзя слить инструмент сам с собой.');
    const [source] = this.db.select().from(instruments).where(eq(instruments.id, sourceId)).all();
    const [target] = this.db.select().from(instruments).where(eq(instruments.id, targetId)).all();
    if (!source) throw new NotFoundException(`Инструмент не найден: ${sourceId}`);
    if (!target) throw new NotFoundException(`Инструмент не найден: ${targetId}`);
    if (source.type !== target.type) {
      throw new BadRequestException(`Нельзя слить инструменты разных типов: ${source.type} → ${target.type}.`);
    }
    return { source, target };
  }

  private checksFor(source: typeof instruments.$inferSelect, target: typeof instruments.$inferSelect): MergeChecks {
    const side = (i: typeof instruments.$inferSelect): MergeCheckInstrument => ({
      id: i.id,
      ticker: i.ticker,
      isin: i.isin,
      entries: this.entriesOf(i.id),
    });
    const sourceOps = this.db
      .select({ date: operations.date, price: operations.price, currency: operations.currency, type: operations.operationType })
      .from(operations)
      .where(eq(operations.instrumentId, source.id))
      .all()
      .filter((o) => o.type === 'Buy' || o.type === 'Sell');
    const targetPrices = this.db
      .select({ date: priceHistory.date, price: priceHistory.price, currency: priceHistory.currency })
      .from(priceHistory)
      .where(eq(priceHistory.instrumentId, target.id))
      .all();
    return mergeChecks(side(source), side(target), { sourceOps, targetPrices });
  }

  /** Предпросмотр разделения: ошибки, предупреждения и состояние обеих сторон до/после — без записи */
  splitPreview(instrumentId: string, raw: unknown): SplitPlan {
    return this.buildSplitPlan(instrumentId, SplitRequestSchema.parse(raw)).plan;
  }

  /**
   * Разделение в ОДНОЙ транзакции: новый инструмент, перенос выбранных операций и кодов, поправки полей
   * остающегося, событие `kind = 'split'` в журнале. Цены остаются у исходного инструмента — историю
   * нового догрузит `PriceHistoryService.ensure`. Откат слияния — то же разделение, план которого
   * заполнен по журналу.
   */
  split(instrumentId: string, raw: unknown): { splitId: string; newInstrumentId: string; movedOperations: number } {
    const request = SplitRequestSchema.parse(raw);
    const { plan, instrument } = this.buildSplitPlan(instrumentId, request);
    if (plan.errors.length > 0) throw new BadRequestException(`Разделение невозможно: ${plan.errors.join(' ')}`);
    if (plan.orphanSellsAppear && !request.confirmOrphanSells) {
      throw new BadRequestException(`Разделение требует подтверждения (confirmOrphanSells): ${plan.warnings.join(' ')}`);
    }
    const ni = request.newInstrument;

    return this.db.transaction((tx) => {
      tx.insert(instruments)
        .values({ id: ni.id, ticker: ni.ticker, type: ni.type, currency: ni.currency, isin: ni.isin ?? null, name: ni.name ?? null, marketSource: ni.marketSource })
        .run();

      // SQLite ограничивает число переменных запроса — переносим пачками
      for (let i = 0; i < plan.movedOperationIds.length; i += 500) {
        tx.update(operations)
          .set({ instrumentId: ni.id })
          .where(inArray(operations.id, plan.movedOperationIds.slice(i, i + 500)))
          .run();
      }
      for (const e of plan.movedIdentifiers) {
        tx.update(instrumentIdentifiers)
          .set({ instrumentId: ni.id, origin: 'manual' })
          .where(and(eq(instrumentIdentifiers.scheme, e.scheme as never), eq(instrumentIdentifiers.value, e.value)))
          .run();
      }
      for (const e of plan.addedIdentifiers) insertIdentifier(tx, { scheme: e.scheme, value: e.value, instrumentId: ni.id, origin: 'manual' });

      const before: Record<string, string | null> = {};
      const after: Record<string, string | null> = {};
      const patch = request.fieldPatches;
      if (patch) {
        const set: { name?: string | null; isin?: string | null } = {};
        for (const key of ['name', 'isin'] as const) {
          if (patch[key] === undefined) continue;
          before[key] = instrument[key] ?? null;
          after[key] = patch[key] ?? null;
          set[key] = patch[key] ?? null;
        }
        if (Object.keys(set).length > 0) tx.update(instruments).set(set).where(eq(instruments.id, instrumentId)).run();
      }

      const payload: SplitPayload = {
        version: 1,
        instrumentId,
        newInstrument: { id: ni.id, ticker: ni.ticker, type: ni.type, currency: ni.currency, isin: ni.isin ?? null, name: ni.name ?? null, marketSource: ni.marketSource },
        movedOperationIds: plan.movedOperationIds,
        movedIdentifiers: plan.movedIdentifiers,
        addedIdentifiers: plan.addedIdentifiers,
        fieldPatches: { before, after },
        undoesMergeId: request.undoesMergeId ?? null,
      };
      const splitId = randomUUID();
      tx.insert(instrumentHistory)
        .values({ id: splitId, kind: 'split', sourceId: instrumentId, targetId: ni.id, payload: JSON.stringify(SplitPayloadV1.parse(payload)) })
        .run();
      return { splitId, newInstrumentId: ni.id, movedOperations: plan.movedOperationIds.length };
    });
  }

  private buildSplitPlan(instrumentId: string, request: ReturnType<typeof SplitRequestSchema.parse>) {
    const [instrument] = this.db.select().from(instruments).where(eq(instruments.id, instrumentId)).all();
    if (!instrument) throw new NotFoundException(`Инструмент не найден: ${instrumentId}`);
    const all = this.db.select({ id: instruments.id, type: instruments.type }).from(instruments).all();
    const plan = planInstrumentSplit({
      instrumentId,
      operations: this.db.select().from(operations).where(eq(operations.instrumentId, instrumentId)).all() as Operation[],
      identifiers: this.entriesOf(instrumentId).map((e) => ({ scheme: e.scheme, value: e.value, origin: e.origin, createdAt: e.createdAt })),
      takenInstrumentIds: new Set(all.map((i) => i.id)),
      takenIdentifierKeys: new Set(this.db.select().from(instrumentIdentifiers).all().map((e) => `${e.scheme}:${e.value}`)),
      request,
      futureIds: new Set(all.filter((i) => i.type === 'Future').map((i) => i.id)),
    });
    return { plan, instrument };
  }

  /**
   * Слить дубль-инструмент в другой в ОДНОЙ транзакции: операции, история цен (только
   * при одинаковой валюте), вариационная маржа и ВСЕ идентификаторы источника переходят
   * к цели (origin 'merge'), затем источник удаляется. Поэтому после удаления сделок и
   * повторного импорта дубль не возвращается: старые коды уже указывают на цель.
   */
  merge(
    sourceId: string,
    targetId: string,
    opts: { confirmWarnings?: boolean } = {},
  ): { merged: true; movedOperations: number } {
    const { source, target } = this.loadPair(sourceId, targetId);
    // проверки повторяются на сервере: клиенту доверять нельзя
    const checks = this.checksFor(source, target);
    if (checks.blockers.length > 0) {
      throw new BadRequestException(`Слияние запрещено: ${checks.blockers.map((b) => b.message).join(' ')}`);
    }
    if (checks.warnings.length > 0 && !opts.confirmWarnings) {
      throw new BadRequestException(
        `Слияние требует подтверждения (confirmWarnings): ${checks.warnings.map((w) => w.message).join(' ')}`,
      );
    }

    return this.db.transaction((tx) => {
      // снимок состояния ДО изменений — в той же транзакции, что и слияние (откат транзакции
      // не оставляет записи журнала)
      const sourceOps = tx.select({ id: operations.id }).from(operations).where(eq(operations.instrumentId, sourceId)).all();
      const sourcePrices = tx.select().from(priceHistory).where(eq(priceHistory.instrumentId, sourceId)).all();
      const [sourceQuote] = tx.select().from(quotes).where(eq(quotes.instrumentId, sourceId)).all();
      const sourceIdentifiers = tx.select().from(instrumentIdentifiers).where(eq(instrumentIdentifiers.instrumentId, sourceId)).all();
      const settlementsBefore = tx.select().from(futuresSettlements).where(eq(futuresSettlements.instrumentId, sourceId)).all();
      const pricesTransferred = source.currency === target.currency;
      const targetPricesOverwritten: MergePayload['targetPricesOverwritten'] = [];
      const targetPricesInserted: MergePayload['targetPricesInserted'] = [];
      const addedIdentifiers: MergePayload['addedIdentifiers'] = [];

      const { changes: movedOperations } = tx
        .update(operations)
        .set({ instrumentId: targetId })
        .where(eq(operations.instrumentId, sourceId))
        .run();

      // история цен переезжает по общей политике источников (рынок цели не затирается);
      // цены в разных валютах на один id смешивать нельзя
      if (pricesTransferred) {
        const rowOf = (date: string) =>
          tx.select().from(priceHistory).where(and(eq(priceHistory.instrumentId, targetId), eq(priceHistory.date, date))).get();
        for (const row of sourcePrices) {
          const before = rowOf(row.date);
          if (!recordPrice(tx, targetId, row)) continue;
          const after = rowOf(row.date);
          if (!after) continue;
          if (before) targetPricesOverwritten.push({ before, after });
          else targetPricesInserted.push(after);
        }
      }
      tx.delete(priceHistory).where(eq(priceHistory.instrumentId, sourceId)).run();
      tx.delete(quotes).where(eq(quotes.instrumentId, sourceId)).run();

      // вариационная маржа из отчётов: переносим, где у цели нет записи на ту же дату
      tx.run(sql`UPDATE OR IGNORE ${futuresSettlements} SET instrument_id = ${targetId} WHERE instrument_id = ${sourceId}`);
      const settlementsLost = tx.select().from(futuresSettlements).where(eq(futuresSettlements.instrumentId, sourceId)).all();
      const lostKeys = new Set(settlementsLost.map((r) => `${r.portfolioId}|${r.date}`));
      const settlementsMoved = settlementsBefore.filter((r) => !lostKeys.has(`${r.portfolioId}|${r.date}`));

      // идентификаторы: все коды источника теперь указывают на цель
      tx.update(instrumentIdentifiers)
        .set({ instrumentId: targetId, origin: 'merge' })
        .where(eq(instrumentIdentifiers.instrumentId, sourceId))
        .run();
      // собственные коды источника, которых могло не быть в таблице (заведён в обход сервиса)
      const own: IdentityEntry[] = [];
      const ticker = normalizeCode(source.ticker);
      if (ticker) own.push({ scheme: 'ticker', value: ticker, instrumentId: targetId, origin: 'merge' });
      const name = normalizeName(source.name);
      if (name) own.push({ scheme: 'name', value: name, instrumentId: targetId, origin: 'merge' });
      for (const e of own) {
        const [taken] = tx
          .select()
          .from(instrumentIdentifiers)
          .where(and(eq(instrumentIdentifiers.scheme, e.scheme), eq(instrumentIdentifiers.value, e.value)))
          .all();
        if (!taken && insertIdentifier(tx, e)) addedIdentifiers.push({ scheme: e.scheme, value: e.value });
      }

      // поля цели, которых не хватало, берём у источника
      const fill: { isin?: string; name?: string } = {};
      if (!target.isin && source.isin) fill.isin = source.isin;
      if (!target.name && source.name) fill.name = source.name;
      if (Object.keys(fill).length > 0) tx.update(instruments).set(fill).where(eq(instruments.id, targetId)).run();

      const payload: MergePayload = {
        version: 1,
        source: { ...source },
        targetFilled: fill,
        sourceQuote: sourceQuote ?? null,
        movedOperationIds: sourceOps.map((o) => o.id),
        sourcePrices,
        pricesTransferred,
        targetPricesOverwritten,
        targetPricesInserted,
        settlementsMoved,
        settlementsLost,
        sourceIdentifiers: sourceIdentifiers.map((e) => ({ scheme: e.scheme, value: e.value, origin: e.origin, createdAt: e.createdAt })),
        addedIdentifiers,
      };
      tx.insert(instrumentHistory)
        .values({ id: randomUUID(), kind: 'merge', sourceId, targetId, payload: JSON.stringify(MergePayloadV1.parse(payload)) })
        .run();

      tx.delete(instruments).where(eq(instruments.id, sourceId)).run();
      return { merged: true as const, movedOperations };
    });
  }
}
