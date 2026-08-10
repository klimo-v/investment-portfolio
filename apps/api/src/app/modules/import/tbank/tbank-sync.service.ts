import { Injectable } from '@nestjs/common';
import { mapTbankOperations, type RawRow, type TbankInstrumentRef, type TbankOperationItem } from '@core';
import { TbankApiClient, type TbankAccount } from './tbank-api.client';

/**
 * Синхронизация истории операций из T-Invest API (Facade, CLAUDE.md §7).
 * Только оркестрация — разбор данных живёт в чистом маппере `@core`
 * (`libs/core/src/lib/parsers/tbank-invest-api.ts`), HTTP — в клиенте.
 *
 * Результат — те же `RawRow[]`, что отдают файловые парсеры, поэтому дальше
 * работает существующий конвейер импорта: нормализация → дедупликация →
 * предпросмотр → commit → rollback.
 */

/**
 * Предохранитель от бесконечного цикла, если брокер вдруг перестанет двигать
 * курсор: 200 страниц по 1000 операций — заведомо больше любой реальной истории.
 */
const MAX_PAGES = 200;
const PAGE_LIMIT = 1000;

@Injectable()
export class TbankSyncService {
  constructor(private readonly api: TbankApiClient) {}

  /** Счета клиента для выбора в UI */
  accounts(): Promise<TbankAccount[]> {
    return this.api.getAccounts();
  }

  /**
   * История операций за период → строки импорта.
   * @param from дата начала включительно, `YYYY-MM-DD`
   * @param to   дата конца включительно, `YYYY-MM-DD`
   */
  async fetchRawRows(accountId: string, from: string, to: string): Promise<RawRow[]> {
    const items = await this.fetchAllOperations(accountId, from, to);
    const instruments = await this.loadInstruments(items);
    return mapTbankOperations(items, accountId, instruments);
  }

  /** Все страницы истории: идём по курсору, пока брокер сообщает `hasNext` */
  private async fetchAllOperations(
    accountId: string,
    from: string,
    to: string,
  ): Promise<TbankOperationItem[]> {
    const items: TbankOperationItem[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.api.getOperationsPage({
        accountId,
        from: `${from}T00:00:00Z`,
        // конец периода включительно: берём последнюю секунду суток `to`
        to: `${to}T23:59:59Z`,
        cursor,
        limit: PAGE_LIMIT,
      });
      items.push(...res.items);

      // курсор не сдвинулся — дальше идти некуда, иначе запрашивали бы ту же страницу
      if (!res.hasNext || !res.nextCursor || res.nextCursor === cursor) break;
      cursor = res.nextCursor;
    }

    return items;
  }

  /**
   * Справочник инструментов для операций: сами операции несут только uid/figi,
   * а импорту нужны тикер, ISIN и название. Запрашиваем по одному разу на
   * уникальный uid — у одного счёта это десятки инструментов, не тысячи.
   *
   * Уид, который брокер не резолвит по `GetInstrumentBy(UID)`, — реальный
   * случай для облигаций закрытого размещения: сделка покупки несёт uid,
   * который каталог не знает, а купонные/погасительные операции по той же
   * бумаге несут другой uid, который резолвится нормально. Без повторного
   * запроса по figi покупка осталась бы безымянной строкой и завела бы в БД
   * дубль-инструмент рядом с уже существующим (найдено на бумаге
   * TCS00A10B4K3/RU000A10B4K3 — ГМК Норникель БО-001Р-08, где figi покупки
   * оказался тем самым идентификатором, по которому находится ТА ЖЕ карточка,
   * что и у купонов).
   */
  private async loadInstruments(
    items: TbankOperationItem[],
  ): Promise<Map<string, TbankInstrumentRef>> {
    const uidToFigi = new Map<string, string>();
    for (const item of items) {
      if (item.instrumentUid && item.figi && !uidToFigi.has(item.instrumentUid)) {
        uidToFigi.set(item.instrumentUid, item.figi);
      }
    }

    const result = new Map<string, TbankInstrumentRef>();
    const uids = new Set(items.map((i) => i.instrumentUid).filter((uid): uid is string => !!uid));
    for (const uid of uids) {
      const instrument =
        (await this.api.getInstrumentByUid(uid)) ??
        (uidToFigi.has(uid) ? await this.api.getInstrumentByFigi(uidToFigi.get(uid) as string) : null);
      if (instrument) result.set(uid, instrument);
    }

    return result;
  }
}
