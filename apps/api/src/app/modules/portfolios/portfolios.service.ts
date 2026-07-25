import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { PortfolioSchema, SystemSchema } from '@core';
import {
  systems,
  portfolios,
  instruments,
  operations,
  type SystemRow,
  type PortfolioRow,
  type InstrumentRow,
} from '../../../db/schema';
import { DB } from '../../db/drizzle.module';

/**
 * Справочники: системы, портфели, инструменты (docs/02-data-model.md §2.2–2.4).
 * Нужны фронту для автокомплита в форме ввода операций (Фаза 2).
 */
@Injectable()
export class PortfoliosService {
  constructor(@Inject(DB) private readonly db: BetterSQLite3Database) {}

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
}
