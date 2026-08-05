import { describe, it, expect, vi } from 'vitest';
import type { TbankOperationItem } from '@core';
import { TbankSyncService } from './tbank-sync.service';
import type { OperationsPage, TbankApiClient } from './tbank-api.client';

/**
 * Проверяем оркестрацию, а не разбор данных: разбор покрыт тестами чистого
 * маппера в libs/core (tbank-invest-api.spec.ts).
 */

function item(id: string): TbankOperationItem {
  return {
    id,
    date: '2026-03-15T10:00:00Z',
    type: 'OPERATION_TYPE_INPUT',
    state: 'OPERATION_STATE_EXECUTED',
    payment: { currency: 'rub', units: '1000', nano: 0 },
  };
}

/** Клиент-заглушка, отдающий заранее заданные страницы курсора */
function clientWithPages(pages: OperationsPage[]) {
  const getOperationsPage = vi.fn(async () => pages.shift() as OperationsPage);
  const getInstrumentByUid = vi.fn(async () => null);
  return {
    client: { getOperationsPage, getInstrumentByUid } as unknown as TbankApiClient,
    getOperationsPage,
    getInstrumentByUid,
  };
}

describe('TbankSyncService — пагинация по курсору', () => {
  it('идёт по страницам, пока брокер сообщает hasNext, и собирает все операции', async () => {
    const { client, getOperationsPage } = clientWithPages([
      { items: [item('a')], hasNext: true, nextCursor: 'c1' },
      { items: [item('b')], hasNext: true, nextCursor: 'c2' },
      { items: [item('c')], hasNext: false },
    ]);

    const rows = await new TbankSyncService(client).fetchRawRows('acc-1', '2026-01-01', '2026-12-31');

    expect(getOperationsPage).toHaveBeenCalledTimes(3);
    expect(rows).toHaveLength(3);
    expect(getOperationsPage.mock.calls[1][0]).toMatchObject({ cursor: 'c1' });
    expect(getOperationsPage.mock.calls[2][0]).toMatchObject({ cursor: 'c2' });
  });

  it('останавливается, если курсор перестал двигаться (иначе — бесконечный цикл)', async () => {
    const page: OperationsPage = { items: [item('a')], hasNext: true, nextCursor: undefined };
    const { client, getOperationsPage } = clientWithPages([page, page, page]);

    const rows = await new TbankSyncService(client).fetchRawRows('acc-1', '2026-01-01', '2026-12-31');

    expect(getOperationsPage).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
  });

  it('запрашивает период целиком по датам, включая последний день', async () => {
    const { client, getOperationsPage } = clientWithPages([{ items: [], hasNext: false }]);

    await new TbankSyncService(client).fetchRawRows('acc-1', '2026-03-01', '2026-03-31');

    expect(getOperationsPage.mock.calls[0][0]).toMatchObject({
      accountId: 'acc-1',
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-31T23:59:59Z',
    });
  });

  it('запрашивает справочник по одному разу на уникальный инструмент', async () => {
    const withUid = (id: string, uid: string) => ({ ...item(id), instrumentUid: uid });
    const { client, getInstrumentByUid } = clientWithPages([
      {
        items: [withUid('a', 'uid-1'), withUid('b', 'uid-1'), withUid('c', 'uid-2')],
        hasNext: false,
      },
    ]);

    await new TbankSyncService(client).fetchRawRows('acc-1', '2026-01-01', '2026-12-31');

    expect(getInstrumentByUid).toHaveBeenCalledTimes(2);
  });
});
