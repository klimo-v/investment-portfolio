import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { z } from 'zod';
import {
  PositionSchema,
  OperationSchema,
  DashboardSummarySchema,
  TradeSchema,
  type Operation,
  type Position,
  type Trade,
} from '@core';
import { SnapshotApi } from '../snapshot/snapshot.api';

/** Глобальный фильтр дашборда (docs/05-review-usability.md §2): система/портфель/период */
export interface SummaryFilter {
  systemId?: string;
  portfolioId?: string;
  from?: string;
  till?: string;
}

/**
 * API-клиент операций и позиций (FSD: entities).
 * Чтение — через httpResource (реактивно, на сигналах, с Zod-валидацией ответа).
 * Мутации (POST) — напрямую через HttpClient (CLAUDE.md §3).
 */
@Injectable({ providedIn: 'root' })
export class OperationApi {
  private readonly http = inject(HttpClient);
  private readonly snapshotApi = inject(SnapshotApi);

  /** триггер перезагрузки: меняем значение → httpResource перезапрашивает */
  private readonly reloadTrigger = signal(0);

  /** Список операций из журнала */
  readonly operations = httpResource(
    () => {
      this.reloadTrigger();
      return '/api/operations';
    },
    { parse: z.array(OperationSchema).parse },
  );

  /** Рассчитанные позиции портфеля */
  readonly positions = httpResource(
    () => {
      this.reloadTrigger();
      return '/api/operations/positions';
    },
    { parse: z.array(PositionSchema).parse },
  );

  /** Сделки: открытые/частично закрытые/закрытые, собранные из операций */
  readonly trades = httpResource(
    () => {
      this.reloadTrigger();
      return '/api/operations/trades';
    },
    { parse: z.array(TradeSchema).parse },
  );

  /** Глобальный фильтр сводки дашборда (система/портфель/период) — управляется страницей */
  readonly summaryFilter = signal<SummaryFilter>({});

  /** Агрегаты для дашборда, с учётом summaryFilter */
  readonly summary = httpResource(
    () => {
      this.reloadTrigger();
      const f = this.summaryFilter();
      const params = new URLSearchParams();
      if (f.systemId) params.set('systemId', f.systemId);
      if (f.portfolioId) params.set('portfolioId', f.portfolioId);
      if (f.from) params.set('from', f.from);
      if (f.till) params.set('till', f.till);
      const qs = params.toString();
      return qs ? `/api/operations/summary?${qs}` : '/api/operations/summary';
    },
    { parse: DashboardSummarySchema.parse },
  );

  /** Добавить операцию (мутация через HttpClient), затем перезагрузить ресурсы */
  async add(operation: Operation): Promise<Operation> {
    const created = await firstValueFrom(
      this.http.post<Operation>('/api/operations', operation),
    );
    this.reloadTrigger.update((n) => n + 1);
    return created;
  }

  /** Удалить одну или несколько операций (безвозвратно), затем перезагрузить ресурсы */
  async remove(ids: string[]): Promise<void> {
    await Promise.all(ids.map((id) => firstValueFrom(this.http.delete<{ deleted: true }>(`/api/operations/${id}`))));
    this.reloadTrigger.update((n) => n + 1);
  }

  /**
   * Назначить систему и/или портфель нескольким операциям сразу (docs/04-roadmap.md
   * §3.1 — разбор отчёта, где сделки принадлежат разным системам/счетам брокера).
   */
  async reassign(ids: string[], patch: { systemId?: string; portfolioId?: string }): Promise<void> {
    await Promise.all(
      ids.map((id) => firstValueFrom(this.http.patch<{ updated: true }>(`/api/operations/${id}`, patch))),
    );
    this.reloadTrigger.update((n) => n + 1);
  }

  /**
   * Обновить котировки с рынка (MOEX/ЦБ), пересчитать позиции и снять снимок
   * стоимости портфеля на сегодня (docs/04-roadmap.md Фаза 5) — снимок должен
   * отражать свежую, а не старую цену, поэтому снимается сразу после обновления.
   */
  async refreshQuotes(): Promise<{ updated: number; total: number }> {
    const result = await firstValueFrom(
      this.http.post<{ updated: number; total: number }>('/api/quotes/refresh', {}),
    );
    this.reloadTrigger.update((n) => n + 1);
    await this.snapshotApi.capture();
    return result;
  }
}

export type { Operation, Position, Trade };
