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
    {
      id: 'LKOH',
      ticker: 'LKOH',
      type: 'Stock',
      currency: 'RUB',
      // внебиржевые сделки Т-Банк репортит по ISIN, а не по тикеру (как и SBER выше)
      isin: 'RU0009024277',
      marketSource: 'moex',
    },
    {
      id: 'X5',
      ticker: 'X5',
      type: 'Stock',
      currency: 'RUB',
      // выплаты по этой бумаге Т-Банк репортит по ISIN (КЦ ИКС 5), а не по тикеру
      isin: 'RU000A108X38',
      marketSource: 'moex',
    },
    { id: 'GAZP', ticker: 'GAZP', type: 'Stock', currency: 'RUB', marketSource: 'moex' },
    { id: 'MOEX', ticker: 'MOEX', type: 'Stock', currency: 'RUB', marketSource: 'moex' },
    { id: 'GLDRUB_TOM', ticker: 'GLDRUB_TOM', type: 'Currency', currency: 'RUB', marketSource: 'moex' },
    { id: 'CNYRUB_TOM', ticker: 'CNYRUB_TOM', type: 'Currency', currency: 'RUB', marketSource: 'moex' },
    { id: 'SBMM', ticker: 'SBMM', type: 'ETF', currency: 'RUB', marketSource: 'moex' },
    { id: 'BTC', ticker: 'BTC', type: 'Crypto', currency: 'USD', marketSource: 'binance' },
    { id: 'USDT', ticker: 'USDT', type: 'Crypto', currency: 'USD', marketSource: 'binance' },
    {
      id: 'RU000A10B4K3',
      ticker: 'RU000A10B4K3',
      type: 'Bond',
      currency: 'USD',
      isin: 'RU000A10B4K3',
      // торгуется на MOEX bonds под тем же SECID, что и ISIN — котировка доступна
      marketSource: 'moex',
    },
    // ОФЗ из xlsx-отчёта Т-Банка — тикер там SECID MOEX (не ISIN, хоть и похож
    // форматом); настоящий ISIN — из раздела «Движение по ценным бумагам»
    // отчёта, нужен на случай, если брокер где-то репортит бумагу по ISIN
    // (купон/выплата), а не по SECID
    { id: 'SU52003RMFS9', ticker: 'SU52003RMFS9', type: 'Bond', currency: 'RUB', isin: 'RU000A102069', marketSource: 'moex' },
    { id: 'SU29008RMFS8', ticker: 'SU29008RMFS8', type: 'Bond', currency: 'RUB', isin: 'RU000A0JV4P3', marketSource: 'moex' },
    { id: 'SU52002RMFS1', ticker: 'SU52002RMFS1', type: 'Bond', currency: 'RUB', isin: 'RU000A0ZYZ26', marketSource: 'moex' },
    { id: 'SU52005RMFS4', ticker: 'SU52005RMFS4', type: 'Bond', currency: 'RUB', isin: 'RU000A105XV1', marketSource: 'moex' },
    { id: 'SU29015RMFS3', ticker: 'SU29015RMFS3', type: 'Bond', currency: 'RUB', isin: 'RU000A1025A7', marketSource: 'moex' },
  ])
  .onConflictDoNothing()
  .run();

// eslint-disable-next-line no-console
console.log(`Справочники загружены в ${DB_PATH}`);
sqlite.close();
