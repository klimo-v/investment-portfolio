import { asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { parseQuikBridgeParams, type QuikBridgeParams } from '@core';
import { strategyConfigs } from '../../../db/schema';

/** Ошибка источника (нет файла моста, нет конфига стратегии и т.п.) — текст для пользователя */
export class StrategySourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrategySourceError';
  }
}

/**
 * Контекст одной стратегии: чья она система, к какому портфелю (счёту) привязана и
 * с какими параметрами читается источник. Все запросы хранилища идут через него —
 * так данные разных стратегий не смешиваются.
 */
export interface StrategyContext {
  systemId: string;
  /** null — счёт ещё не привязан к портфелю; меняется через Yv1Store.linkPortfolio */
  portfolioId: string | null;
  params: QuikBridgeParams;
}

/**
 * Найти конфиг стратегии с адаптером `quik-bridge`.
 * Без `systemId` берётся единственный такой конфиг; если их несколько — нужно указать, какой.
 */
export function loadStrategyContext(db: BetterSQLite3Database, systemId?: string): StrategyContext {
  const rows = db
    .select()
    .from(strategyConfigs)
    .where(eq(strategyConfigs.adapter, 'quik-bridge'))
    .orderBy(asc(strategyConfigs.createdAt))
    .all();
  const row = systemId ? rows.find((r) => r.systemId === systemId) : rows.length === 1 ? rows[0] : undefined;
  if (!row) {
    throw new StrategySourceError(
      systemId
        ? `Конфиг стратегии не найден: ${systemId}.`
        : rows.length === 0
          ? 'Нет ни одной стратегии с адаптером quik-bridge (таблица strategy_configs).'
          : 'Стратегий с адаптером quik-bridge несколько — укажите systemId.',
    );
  }
  let params: QuikBridgeParams;
  try {
    params = parseQuikBridgeParams(row.params);
  } catch (e) {
    throw new StrategySourceError(`Параметры стратегии ${row.systemId} некорректны: ${(e as Error).message}`);
  }
  return { systemId: row.systemId, portfolioId: row.portfolioId, params };
}
