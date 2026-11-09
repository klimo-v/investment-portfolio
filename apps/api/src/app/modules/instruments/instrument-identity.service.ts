import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  findPossibleDuplicates,
  identityConflicts,
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
  instrumentIdentifiers,
  instruments,
  operations,
  priceHistory,
  quotes,
} from '../../../db/schema';
import { DB } from '../../db/drizzle.module';

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
    return this.toIdentifiersDto(instrument, this.entriesOf(instrumentId));
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
        const dto = this.toIdentifiersDto(i, entries);
        return entries.some((e) => e.origin === 'merge') || dto.conflicting ? [dto] : [];
      })
      .sort((a, b) => Number(b.conflicting) - Number(a.conflicting) || a.ticker.localeCompare(b.ticker));
  }

  private entriesOf(instrumentId: string) {
    return this.db.select().from(instrumentIdentifiers).where(eq(instrumentIdentifiers.instrumentId, instrumentId)).all();
  }

  private toIdentifiersDto(
    instrument: { id: string; ticker: string; name: string | null },
    entries: { scheme: string; value: string; origin: string; createdAt: string }[],
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
    };
  }

  /**
   * Слить дубль-инструмент в другой в ОДНОЙ транзакции: операции, история цен (только
   * при одинаковой валюте), вариационная маржа и ВСЕ идентификаторы источника переходят
   * к цели (origin 'merge'), затем источник удаляется. Поэтому после удаления сделок и
   * повторного импорта дубль не возвращается: старые коды уже указывают на цель.
   */
  merge(sourceId: string, targetId: string): { merged: true; movedOperations: number } {
    if (sourceId === targetId) throw new BadRequestException('Нельзя слить инструмент сам с собой.');
    const [source] = this.db.select().from(instruments).where(eq(instruments.id, sourceId)).all();
    const [target] = this.db.select().from(instruments).where(eq(instruments.id, targetId)).all();
    if (!source) throw new NotFoundException(`Инструмент не найден: ${sourceId}`);
    if (!target) throw new NotFoundException(`Инструмент не найден: ${targetId}`);
    if (source.type !== target.type) {
      throw new BadRequestException(`Нельзя слить инструменты разных типов: ${source.type} → ${target.type}.`);
    }

    return this.db.transaction((tx) => {
      const { changes: movedOperations } = tx
        .update(operations)
        .set({ instrumentId: targetId })
        .where(eq(operations.instrumentId, sourceId))
        .run();

      // история цен переезжает по общей политике источников (рынок цели не затирается);
      // цены в разных валютах на один id смешивать нельзя
      if (source.currency === target.currency) {
        for (const row of tx.select().from(priceHistory).where(eq(priceHistory.instrumentId, sourceId)).all()) {
          recordPrice(tx, targetId, row);
        }
      }
      tx.delete(priceHistory).where(eq(priceHistory.instrumentId, sourceId)).run();
      tx.delete(quotes).where(eq(quotes.instrumentId, sourceId)).run();

      // вариационная маржа из отчётов: переносим, где у цели нет записи на ту же дату
      tx.run(sql`UPDATE OR IGNORE ${futuresSettlements} SET instrument_id = ${targetId} WHERE instrument_id = ${sourceId}`);

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
        if (!taken) insertIdentifier(tx, e);
      }

      // поля цели, которых не хватало, берём у источника
      const fill: { isin?: string; name?: string } = {};
      if (!target.isin && source.isin) fill.isin = source.isin;
      if (!target.name && source.name) fill.name = source.name;
      if (Object.keys(fill).length > 0) tx.update(instruments).set(fill).where(eq(instruments.id, targetId)).run();

      tx.delete(instruments).where(eq(instruments.id, sourceId)).run();
      return { merged: true as const, movedOperations };
    });
  }
}
