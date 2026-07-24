import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { systems, portfolios, instruments } from './schema';
import { resolveDbPath } from './db-path';

/**
 * Seed справочников из реальных данных пользователя (для первого локального запуска).
 * Запуск: pnpm db:seed
 */
const DB_PATH = resolveDbPath();
const sqlite = new Database(DB_PATH);
const db = drizzle(sqlite);

db.insert(systems)
  .values([
    { id: 'vernikov', name: 'Верников' },
    { id: 'vernikov_trading', name: 'Верников_трейдинг' },
    { id: 'crypto_trading', name: 'Трейдинг_крипта' },
  ])
  .onConflictDoNothing()
  .run();

db.insert(portfolios)
  .values([{ id: 'tinkoff', name: 'Tinkoff', broker: 'Tinkoff', baseCurrency: 'RUB' }])
  .onConflictDoNothing()
  .run();

db.insert(instruments)
  .values([
    {
      id: 'SBER',
      ticker: 'SBER',
      type: 'Stock',
      currency: 'RUB',
      // некоторые брокеры (Т-Банк, отдельная площадка) репортят эту же акцию по
      // ISIN вместо тикера — резолвер инструмента ищет и по ISIN (apps/api/.../import.service.ts)
      isin: 'RU0009029540',
      marketSource: 'moex',
    },
    { id: 'TMON', ticker: 'TMON', type: 'ETF', currency: 'RUB', marketSource: 'moex' },
    { id: 'LKOH', ticker: 'LKOH', type: 'Stock', currency: 'RUB', marketSource: 'moex' },
    { id: 'X5', ticker: 'X5', type: 'Stock', currency: 'RUB', marketSource: 'moex' },
    { id: 'GAZP', ticker: 'GAZP', type: 'Stock', currency: 'RUB', marketSource: 'moex' },
    { id: 'MOEX', ticker: 'MOEX', type: 'Stock', currency: 'RUB', marketSource: 'moex' },
    { id: 'GLDRUB_TOM', ticker: 'GLDRUB_TOM', type: 'Currency', currency: 'RUB', marketSource: 'moex' },
    { id: 'SBMM', ticker: 'SBMM', type: 'ETF', currency: 'RUB', marketSource: 'moex' },
    { id: 'BTC', ticker: 'BTC', type: 'Crypto', currency: 'USD', marketSource: 'binance' },
    { id: 'USDT', ticker: 'USDT', type: 'Crypto', currency: 'USD', marketSource: 'binance' },
    {
      id: 'RU000A10B4K3',
      ticker: 'RU000A10B4K3',
      type: 'Bond',
      currency: 'USD',
      isin: 'RU000A10B4K3',
      marketSource: 'manual',
    },
    // ОФЗ из xlsx-отчёта Т-Банка — тикер там уже SECID MOEX (не отдельный ISIN)
    { id: 'SU52003RMFS9', ticker: 'SU52003RMFS9', type: 'Bond', currency: 'RUB', marketSource: 'moex' },
    { id: 'SU29008RMFS8', ticker: 'SU29008RMFS8', type: 'Bond', currency: 'RUB', marketSource: 'moex' },
    { id: 'SU52002RMFS1', ticker: 'SU52002RMFS1', type: 'Bond', currency: 'RUB', marketSource: 'moex' },
    { id: 'SU52005RMFS4', ticker: 'SU52005RMFS4', type: 'Bond', currency: 'RUB', marketSource: 'moex' },
    { id: 'SU29015RMFS3', ticker: 'SU29015RMFS3', type: 'Bond', currency: 'RUB', marketSource: 'moex' },
  ])
  .onConflictDoNothing()
  .run();

// eslint-disable-next-line no-console
console.log(`Справочники загружены в ${DB_PATH}`);
sqlite.close();
