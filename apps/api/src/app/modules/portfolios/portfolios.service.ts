import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { PortfolioSchema, SystemSchema, type InstrumentIdentifiersDto, type SplitPlan } from '@core';
import {
  systems,
  portfolios,
  instruments,
  operations,
  type SystemRow,
  type PortfolioRow,
  type InstrumentRow,
} from '../../../db/schema';
import { InstrumentIdentityService, type MergePreviewDto, type PossibleDuplicateDto } from '../instruments/instrument-identity.service';
import { DB } from '../../db/drizzle.module';

/**
 * Справочники: системы, портфели, инструменты (docs/02-data-model.md §2.2–2.4).
 * Нужны фронту для автокомплита в форме ввода операций (Фаза 2).
 */
@Injectable()
export class PortfoliosService {
  constructor(
    @Inject(DB) private readonly db: BetterSQLite3Database,
    private readonly identity: InstrumentIdentityService,
  ) {}

  listSystems(): SystemRow[] {
    return this.db.select().from(systems).all();
  }

  /** Валидация тела через Zod (CLAUDE.md §8), затем запись в БД */
  createSystem(raw: unknown): SystemRow {
    const parsed = SystemSchema.parse(raw);
    const id = parsed.id ?? randomUUID();

    this.db
      .insert(systems)
      .values({
        id,
        name: parsed.name,
        description: parsed.description ?? null,
        color: parsed.color ?? null,
      })
      .run();

    return { id, name: parsed.name, description: parsed.description ?? null, color: parsed.color ?? null };
  }

  /**
   * Удаление системы. Отклоняем, если на неё уже ссылаются операции —
   * иначе пользователь потеряет журнал сделок без явного предупреждения.
   */
  deleteSystem(id: string): void {
    const [{ count }] = this.db
      .select({ count: sql<number>`count(*)` })
      .from(operations)
      .where(eq(operations.systemId, id))
      .all();

    if (count > 0) {
      throw new BadRequestException(
        `Нельзя удалить систему: с ней связано операций — ${count}. Сначала удалите или перенесите операции.`,
      );
    }

    this.db.delete(systems).where(eq(systems.id, id)).run();
  }

  listPortfolios(): PortfolioRow[] {
    return this.db.select().from(portfolios).all();
  }

  listInstruments(): InstrumentRow[] {
    return this.db.select().from(instruments).all();
  }

  /** Валидация тела через Zod (CLAUDE.md §8), затем запись в БД */
  createPortfolio(raw: unknown): PortfolioRow {
    const parsed = PortfolioSchema.parse(raw);
    const id = parsed.id ?? randomUUID();

    this.db
      .insert(portfolios)
      .values({
        id,
        name: parsed.name,
      })
      .run();

    return {
      id,
      name: parsed.name,
      accountRef: null,
    };
  }

  /**
   * Удаление портфеля. Отклоняем, если на него уже ссылаются операции —
   * иначе пользователь потеряет журнал сделок без явного предупреждения.
   */
  deletePortfolio(id: string): void {
    const [{ count }] = this.db
      .select({ count: sql<number>`count(*)` })
      .from(operations)
      .where(eq(operations.portfolioId, id))
      .all();

    if (count > 0) {
      throw new BadRequestException(
        `Нельзя удалить портфель: с ним связано операций — ${count}. Сначала удалите или перенесите операции.`,
      );
    }

    this.db.delete(portfolios).where(eq(portfolios.id, id)).run();
  }

  /**
   * Слить дубль-инструмент в другой. Вся работа — в InstrumentIdentityService: он же
   * единственный пишет идентификаторы инструментов, поэтому решение запоминается.
   */
  /** «Возможные дубли» справочника (эвристики core) с предложенным направлением слияния */
  possibleDuplicates(): PossibleDuplicateDto[] {
    return this.identity.possibleDuplicates();
  }

  instrumentIdentifiers(instrumentId: string): InstrumentIdentifiersDto {
    return this.identity.identifiers(instrumentId);
  }

  mergedIdentifiers(): InstrumentIdentifiersDto[] {
    return this.identity.mergedIdentifiers();
  }

  splitPreview(instrumentId: string, body: unknown): SplitPlan {
    return this.identity.splitPreview(instrumentId, body);
  }

  splitInstrument(instrumentId: string, body: unknown): { splitId: string; newInstrumentId: string; movedOperations: number } {
    return this.identity.split(instrumentId, body);
  }

  mergePreview(sourceId: string, targetId: string): MergePreviewDto {
    return this.identity.mergePreview(sourceId, targetId);
  }

  mergeInstruments(
    sourceId: string,
    targetId: string,
    opts: { confirmWarnings?: boolean } = {},
  ): { merged: true; movedOperations: number } {
    return this.identity.merge(sourceId, targetId, opts);
  }
}
