import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { PortfolioSchema, SystemSchema } from '@core';
import {
  systems,
  portfolios,
  instruments,
  operations,
  quotes,
  priceHistory,
  type SystemRow,
  type PortfolioRow,
  type InstrumentRow,
} from '../../../db/schema';
import { recordPrice } from '../../../db/price-history-store';
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

  /**
   * Слить дубль-инструмент в другой: перевесить его операции на targetId и удалить
   * саму запись source. Нужен, когда брокерский импорт заводит два справочных
   * инструмента на один и тот же реальный актив под разными кодами (напр. T-Invest
   * API отдаёт отдельную запись «TMON@» для автосвипа в фонд денежного рынка рядом
   * с биржевым «TMON») — тикер/ISIN/имя при этом могут не совпадать вовсе, поэтому
   * такое слияние делает пользователь вручную, а не эвристика при импорте.
   *
   * Котировка source (если есть) удаляется вместе с ним — она обычно для другой
   * валюты/цены и была бы неверной под чужим instrumentId. История цен переезжает к
   * целевому инструменту по общей политике источников.
   */
  mergeInstruments(sourceId: string, targetId: string): { merged: true; movedOperations: number } {
    if (sourceId === targetId) {
      throw new BadRequestException('Нельзя слить инструмент сам с собой.');
    }
    const [source] = this.db.select().from(instruments).where(eq(instruments.id, sourceId)).all();
    const [target] = this.db.select().from(instruments).where(eq(instruments.id, targetId)).all();
    if (!source) throw new NotFoundException(`Инструмент не найден: ${sourceId}`);
    if (!target) throw new NotFoundException(`Инструмент не найден: ${targetId}`);
    if (source.type !== target.type) {
      throw new BadRequestException(
        `Нельзя слить инструменты разных типов: ${source.type} → ${target.type}.`,
      );
    }

    const { changes: movedOperations } = this.db
      .update(operations)
      .set({ instrumentId: targetId })
      .where(eq(operations.instrumentId, sourceId))
      .run();

    // история цен переезжает к целевому инструменту по общей политике источников
    // (рынок цели не затирается ценой слитого), остальное удаляется вместе с ним
    // только при совпадении валюты инструмента: цены в разных валютах/масштабах на один id смешивать нельзя
    if (source.currency === target.currency) {
      for (const row of this.db.select().from(priceHistory).where(eq(priceHistory.instrumentId, sourceId)).all()) {
        recordPrice(this.db, targetId, row);
      }
    }
    this.db.delete(priceHistory).where(eq(priceHistory.instrumentId, sourceId)).run();
    this.db.delete(quotes).where(eq(quotes.instrumentId, sourceId)).run();
    this.db.delete(instruments).where(eq(instruments.id, sourceId)).run();

    return { merged: true, movedOperations };
  }
}
