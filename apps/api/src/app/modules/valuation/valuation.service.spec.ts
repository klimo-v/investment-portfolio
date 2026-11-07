import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { instruments, operations, portfolios, priceHistory, quotes, systems } from '../../../db/schema';
import { OperationsService } from '../operations/operations.service';
import { PriceHistoryService } from '../quotes/price-history.service';
import type { QuotesService } from '../quotes/quotes.service';
import { ValuationService } from './valuation.service';

const quotesStub = { getFxRate: async () => 1, getFxRateOrNull: async () => 1 } as unknown as QuotesService;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

let db: BetterSQLite3Database;
let service: ValuationService;
let ops: OperationsService;

beforeEach(() => {
  const sqlite = new Database(':memory:');
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
  db = drizzle(sqlite);
  db.insert(systems).values({ id: 's', name: 'S' }).run();
  db.insert(portfolios).values({ id: 'p', name: 'P' }).run();
  db.insert(instruments).values({ id: 'SBER', ticker: 'SBER', type: 'Stock', currency: 'RUB', marketSource: 'manual' }).run();
  db.insert(operations)
    .values({ id: randomUUID(), date: day(-10), systemId: 's', portfolioId: 'p', instrumentId: 'SBER', operationType: 'Buy', quantity: '10', price: '100', currency: 'RUB' })
    .run();
  ops = new OperationsService(db, quotesStub);
  service = new ValuationService(db, ops, new PriceHistoryService(db, []), quotesStub);
});

const last = async () => {
  const s = await service.series({ groupBy: 'instrument' });
  return s.groups[0].points.at(-1)!;
};

describe('ValuationService: котировки как наблюдения', () => {
  it('свежая котировка (сегодня) даёт сегодняшнюю оценку', async () => {
    db.insert(quotes).values({ instrumentId: 'SBER', price: '120', currency: 'RUB', source: 'manual', asOf: new Date().toISOString() }).run();
    expect((await last()).marketValueRub).toBe('1200.00');
  });

  it('устаревшая котировка не перебивает более свежую историю цен (нет скачка в последний день)', async () => {
    // котировка трёхдневной давности — 110, а в истории есть цена вчера — 130
    db.insert(quotes).values({ instrumentId: 'SBER', price: '110', currency: 'RUB', source: 'manual', asOf: `${day(-3)}T00:00:00.000Z` }).run();
    db.insert(priceHistory).values({ instrumentId: 'SBER', date: day(-1), price: '130', currency: 'RUB', source: 'moex' }).run();
    const p = await last();
    expect(p.marketValueRub).toBe('1300.00');
    const s = await service.series({ groupBy: 'instrument' });
    const at = (d: string) => s.groups[0].points.find((x) => x.date === d)!;
    expect(at(day(-3)).marketValueRub).toBe('1100.00'); // котировка действует со своей даты
    expect(at(day(-2)).marketValueRub).toBe('1100.00');
    expect(at(day(-1)).marketValueRub).toBe('1300.00');
  });

  it('единственная котировка старше истории цен продолжает действовать вперёд (итог = сводка)', async () => {
    db.insert(quotes).values({ instrumentId: 'SBER', price: '110', currency: 'RUB', source: 'manual', asOf: `${day(-3)}T00:00:00.000Z` }).run();
    expect((await last()).marketValueRub).toBe('1100.00');
  });
});

describe('одна текущая цена для сделок, позиций и ряда', () => {
  it('устаревшая котировка и более свежая история: сделки/позиции и последняя точка ряда оценены одинаково', async () => {
    db.insert(quotes).values({ instrumentId: 'SBER', price: '110', currency: 'RUB', source: 'manual', asOf: `${day(-3)}T00:00:00.000Z` }).run();
    db.insert(priceHistory).values({ instrumentId: 'SBER', date: day(-1), price: '130', currency: 'RUB', source: 'moex' }).run();
    const [trade] = await ops.trades();
    const [position] = await ops.positions();
    expect(trade.currentPrice).toBe('130');
    expect(trade.currentValueRub).toBe('1300.00');
    expect(position.currentValueRub).toBe('1300.00');
    expect((await last()).marketValueRub).toBe('1300.00');
  });

  it('равная дата: побеждает котировка (она не старше)', async () => {
    db.insert(quotes).values({ instrumentId: 'SBER', price: '125', currency: 'RUB', source: 'moex', asOf: `${day(-1)}T10:00:00.000Z` }).run();
    db.insert(priceHistory).values({ instrumentId: 'SBER', date: day(-1), price: '130', currency: 'RUB', source: 'moex' }).run();
    const [trade] = await ops.trades();
    expect(trade.currentPrice).toBe('125');
  });
});
