import { Injectable, inject } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { z } from 'zod';
import { OperationSchema, type Operation } from '@core';
import { ToastService, withToastSuccess } from '@web-shared';
import { DataRevision } from '../../shared/data-revision';
import { SnapshotApi } from '../snapshot/snapshot.api';

/**
 * Журнал операций и мутации над ним (FSD: entities).
 * Чтение — через httpResource (реактивно, на сигналах, с Zod-валидацией ответа).
 * Мутации (POST/PATCH/DELETE) — напрямую через HttpClient (CLAUDE.md §3).
 *
 * Позиции, сделки и сводка переехали в собственные сервисы (`PositionApi`,
 * `TradeApi`, `summaryResource`): раньше все четыре ресурса создавались здесь, а
 * httpResource стартует при создании — страница, которой нужен один список,
 * поднимала все четыре запроса («Портфель» тянул сделки, «Сделки» — позиции).
 * Общей осталась ровно инвалидация после мутаций — `DataRevision`.
 */
@Injectable({ providedIn: 'root' })
export class OperationApi {
  private readonly http = inject(HttpClient);
  private readonly snapshotApi = inject(SnapshotApi);
  private readonly toast = inject(ToastService);
  private readonly revision = inject(DataRevision);

  /** Список операций из журнала */
  readonly operations = httpResource(
    () => {
      this.revision.value();
      return '/api/operations';
    },
    { parse: z.array(OperationSchema).parse },
  );

  /**
   * Перезапросить данные. Нужен кнопке «Повторить» в состоянии ошибки: до
   * этого единственным способом выйти из «не удалось загрузить» была перезагрузка
   * страницы целиком.
   */
  reload(): void {
    this.revision.bump();
  }

  /** Добавить операцию (мутация через HttpClient), затем перезагрузить ресурсы */
  async add(operation: Operation): Promise<Operation> {
    const created = await firstValueFrom(
      this.http.post<Operation>('/api/operations', operation, withToastSuccess('Операция добавлена')),
    );
    this.revision.bump();
    return created;
  }

  /**
   * Удалить одну или несколько операций (безвозвратно), затем перезагрузить ресурсы.
   * Тост — один на весь батч (не на withToastSuccess каждого запроса Promise.all,
   * иначе на массовое удаление посыпалась бы пачка одинаковых тостов).
   */
  async remove(ids: string[]): Promise<void> {
    await Promise.all(
      ids.map((id) => firstValueFrom(this.http.delete<{ deleted: true }>(`/api/operations/${id}`))),
    );
    this.revision.bump();
    this.toast.success(ids.length === 1 ? 'Операция удалена' : `Операции удалены (${ids.length})`);
  }

  /**
   * Назначить систему и/или портфель нескольким операциям сразу (docs/04-roadmap.md
   * §3.1 — разбор отчёта, где сделки принадлежат разным системам/счетам брокера).
   * Тост — один на весь батч (см. remove()).
   */
  async reassign(ids: string[], patch: { systemId?: string; portfolioId?: string }): Promise<void> {
    await Promise.all(
      ids.map((id) => firstValueFrom(this.http.patch<{ updated: true }>(`/api/operations/${id}`, patch))),
    );
    this.revision.bump();
    this.toast.success('Система/портфель переназначены');
  }

  /**
   * Обновить котировки с рынка (MOEX/ЦБ), пересчитать позиции и снять снимок
   * стоимости портфеля на сегодня (docs/04-roadmap.md Фаза 5) — снимок должен
   * отражать свежую, а не старую цену, поэтому снимается сразу после обновления.
   */
  async refreshQuotes(): Promise<{ updated: number; total: number }> {
    const result = await firstValueFrom(
      this.http.post<{ updated: number; total: number }>(
        '/api/quotes/refresh',
        {},
        withToastSuccess('Котировки обновлены'),
      ),
    );
    this.revision.bump();
    await this.snapshotApi.capture();
    return result;
  }

  /**
   * Установить цену вручную (marketSource='manual' — своего провайдера нет и не
   * будет, см. QuotesService.refreshAll). Бэк отклонит вызов для инструмента с
   * автоматическим источником — интерцептор сам покажет тост с причиной отказа.
   */
  async setManualPrice(instrumentId: string, price: string): Promise<void> {
    await firstValueFrom(
      this.http.post(
        `/api/quotes/${instrumentId}/manual`,
        { price },
        withToastSuccess('Цена установлена'),
      ),
    );
    this.revision.bump();
  }
}

export type { Operation };
