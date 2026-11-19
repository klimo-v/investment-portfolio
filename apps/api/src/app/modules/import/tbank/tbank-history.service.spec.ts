import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapTbankOperations, type RawRow, type TbankOperationItem } from '@core';
import { instrumentIdentifiers, instruments, operationAnnotations, operations, portfolios, systems } from '../../../../db/schema';
import { TbankHistoryService } from './tbank-history.service';
import type { TbankSyncService } from './tbank-sync.service';

const request = { accountId: 'account-a', portfolioId: 'portfolio-a', from: '2026-07-06', to: '2026-07-17' };
const date = '2026-07-07';
function apiItem(): TbankOperationItem {
  return {
    id: 'api-parent',
    state: 'OPERATION_STATE_EXECUTED',
    type: 'OPERATION_TYPE_BUY',
    date: date + 'T09:00:00Z',
    figi: 'test-figi',
    instrumentType: 'bond',
    quantityDone: '2',
    payment: { currency: 'rub', units: '-201' },
    tradesInfo: {
      trades: [{ num: 'exchange-1', quantity: '2', price: { currency: 'rub', units: '100' } }],
    },
  };
}

function apiRows(item = apiItem()): RawRow[] {
  const coupon: TbankOperationItem = {
    ...item, id: 'coupon-api-ref', type: 'OPERATION_TYPE_COUPON',
    payment: { currency: 'rub', units: '7' },
  };
  return mapTbankOperations([item, coupon], request.accountId);
}

describe('обогащение истории через API', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let service: TbankHistoryService;
  const fetchRawRows = vi.fn<TbankSyncService['fetchRawRows']>();

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    db.insert(systems).values({ id: 's', name: 'Система сделок' }).run();
    db.insert(portfolios).values([
      { id: request.portfolioId, name: 'Первый портфель', accountRef: request.accountId },
      { id: 'portfolio-b', name: 'Второй портфель', accountRef: 'account-b' },
    ]).run();
    db.insert(instruments).values({ id: 'bond', ticker: 'BOND', type: 'Bond', currency: 'RUB' }).run();
    db.insert(instrumentIdentifiers).values({
      scheme: 'figi', value: 'TEST-FIGI', instrumentId: 'bond', origin: 'import',
    }).run();
    const buy = {
      id: 'buy-a', date, portfolioId: request.portfolioId, systemId: 's', instrumentId: 'bond',
      operationType: 'Buy', quantity: '2', price: '100', fee: '1.25', fxRate: '1',
      currency: 'RUB', brokerRef: 'exchange-1', note: 'Заметка пользователя',
    } as const;
    db.insert(operations).values([
      buy,
      { ...buy, id: 'buy-b', portfolioId: 'portfolio-b' },
      { ...buy, id: 'coupon', operationType: 'Coupon', quantity: '1', price: '7', fee: '0', brokerRef: 'old-coupon-ref' },
    ]).run();
    db.insert(operationAnnotations).values({
      operationId: 'buy-a', tag: 'держать', signalPrice: '99', source: 'test', importedAt: date,
    }).run();
    fetchRawRows.mockReset().mockResolvedValue(apiRows());
    service = new TbankHistoryService(db, { fetchRawRows } as unknown as TbankSyncService);
  });
  afterEach(() => sqlite.close());

  const operationRows = () => db.select().from(operations).orderBy(operations.id).all();
  const bindings = () => db.select().from(portfolios).orderBy(portfolios.id).all();

  it('обновляет только сумму и происхождение сделки выбранного счёта, выплаты и аннотации совпадают побайтно', async () => {
    const before = operationRows();
    const bindingsBefore = bindings();
    const annotations = db.select().from(operationAnnotations).all();
    const preview = await service.preview(request);
    expect(fetchRawRows).toHaveBeenCalledWith(request.accountId, request.from, request.to);
    expect(preview.summary).toEqual({ update: 1, matched: 0, unmatched: 0, conflict: 0, unknown: 0 });
    expect(operationRows()).toEqual(before);

    expect(service.commit(preview.previewId)).toMatchObject({ imported: 0, updated: 1 });
    expect(operationRows()).toEqual([
      { ...before[0], grossTradeAmount: '201', grossTradeAmountSource: 'tbank-payment' },
      before[1], before[2],
    ]);
    expect(bindings()).toEqual(bindingsBefore);
    expect(db.select().from(operationAnnotations).all()).toEqual(annotations);

    const repeat = await service.preview(request);
    expect(repeat.summary).toMatchObject({ update: 0, matched: 1 });
    expect(service.commit(repeat.previewId)).toMatchObject({ imported: 0, updated: 0 });
    expect(service.commit(preview.previewId)).toMatchObject({ imported: 0, updated: 0 });
  });

  it('не включает акции в сверку облигаций', async () => {
    const stock = { ...apiItem(), instrumentType: 'share' };
    fetchRawRows.mockResolvedValue(apiRows(stock));
    db.update(instruments).set({ type: 'Stock' }).where(eq(instruments.id, 'bond')).run();
    expect((await service.preview(request)).rows).toEqual([]);
  });

  it('проверяет дату и уникальность номера по всему счёту', async () => {
    db.update(operations).set({ date: '2026-07-08' }).where(eq(operations.id, 'buy-a')).run();
    expect((await service.preview(request)).summary).toMatchObject({ conflict: 1, update: 0 });
    db.update(operations).set({ date }).where(eq(operations.id, 'buy-a')).run();
    const stored = db.select().from(operations).where(eq(operations.id, 'buy-a')).get()!;
    db.insert(operations).values({ ...stored, id: 'older', date: '2026-01-01' }).run();
    expect((await service.preview(request)).summary).toMatchObject({ conflict: 1, update: 0 });
  });

  it('блокирует неверную привязку портфеля и не запрашивает историю чужого счёта', async () => {
    const before = bindings();
    const preview = await service.preview({ ...request, accountId: 'account-b' });
    expect(preview.bindingIssue).toContain('отличается от привязки');
    expect(fetchRawRows).not.toHaveBeenCalled();
    expect(() => service.commit(preview.previewId)).toThrow();
    expect(bindings()).toEqual(before);
  });

  it('повторно проверяет привязку и данные перед записью', async () => {
    const preview = await service.preview(request);
    db.update(operations).set({ quantity: '3' }).where(eq(operations.id, 'buy-a')).run();
    expect(service.commit(preview.previewId)).toMatchObject({
      imported: 0, updated: 0, preview: { summary: { update: 0, conflict: 1 } },
    });
    db.update(portfolios).set({ accountRef: 'other-account' }).where(eq(portfolios.id, request.portfolioId)).run();
    expect(() => service.commit(preview.previewId)).toThrow('отличается от привязки');
    expect(operationRows()[0].grossTradeAmount).toBeNull();
  });

  it('сохраняет ранее подтверждённую сумму при неполном ответе API', async () => {
    service.commit((await service.preview(request)).previewId);
    const item = apiItem();
    delete item.payment;
    fetchRawRows.mockResolvedValue(apiRows(item));
    const preview = await service.preview(request);
    expect(preview.summary).toMatchObject({ update: 0, unknown: 1 });
    expect(service.commit(preview.previewId)).toMatchObject({ imported: 0, updated: 0 });
    expect(operationRows()[0]).toMatchObject({ grossTradeAmount: '201', grossTradeAmountSource: 'tbank-payment' });
  });

  it('отказывается подменять подтверждённую сумму при расхождении', async () => {
    service.commit((await service.preview(request)).previewId);
    fetchRawRows.mockResolvedValue(apiRows({ ...apiItem(), payment: { currency: 'rub', units: '-202' } }));
    const preview = await service.preview(request);
    expect(preview.summary).toMatchObject({ conflict: 1, update: 0 });
    expect(operationRows()[0].grossTradeAmount).toBe('201');
  });

  it('не обновляет сделку по одному лишь совпадению родительского ID', async () => {
    db.update(operations).set({ brokerRef: apiItem().id }).where(eq(operations.id, 'buy-a')).run();
    const item = apiItem();
    delete item.tradesInfo;
    fetchRawRows.mockResolvedValue(apiRows(item));
    const preview = await service.preview(request);
    expect(preview.summary).toMatchObject({ unknown: 1, unmatched: 1, update: 0 });
    expect(service.commit(preview.previewId)).toMatchObject({ imported: 0, updated: 0 });
  });
});
