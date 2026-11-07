import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { StrategyAdapterId } from '@core';
import { Yv1Store } from '../yv1/yv1.store';
import type { StrategyAdapter } from './strategy-adapter';

/**
 * Фабрика адаптеров по `strategy_configs.adapter` (GoF Factory Method). `switch` по
 * закрытому union: добавили id в `STRATEGY_ADAPTER_IDS` — компилятор потребует ветку здесь.
 */
export function createStrategyAdapter(
  id: StrategyAdapterId,
  db: BetterSQLite3Database,
  systemId: string,
): StrategyAdapter {
  switch (id) {
    case 'quik-bridge':
      return new Yv1Store(db, undefined, systemId);
    default: {
      const unreachable: never = id;
      throw new Error(`Неизвестный адаптер стратегии: ${String(unreachable)}`);
    }
  }
}
