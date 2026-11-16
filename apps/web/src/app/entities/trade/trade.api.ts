import { Injectable, inject, type Signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { z } from 'zod';
import { TradeSchema, type SystemPerformanceQuery, type Trade } from '@core';
import { DataRevision } from '../../shared/data-revision';

/**
 * Сделки — открытые, частично и полностью закрытые (FSD: entities). Не хранятся:
 * движок `@core` (calculateTrades) пересобирает их из всей истории операций.
 *
 * Отдельный сервис по той же причине, что и `PositionApi` — httpResource
 * запрашивает при создании, и общий сервис поднимал лишние запросы на страницах,
 * которым сделки не нужны.
 */
@Injectable({ providedIn: 'root' })
export class TradeApi {
  readonly trades = tradesResource();
}

/** Без фильтра — журнал сделок; с фильтром — состояние на конец выбранного периода. */
export function tradesResource(filter?: Signal<(SystemPerformanceQuery & { systemId: string }) | null>) {
  const revision = inject(DataRevision);
  return httpResource(() => {
    revision.value();
    if (!filter) return '/api/operations/trades';
    const value = filter();
    if (!value) return undefined;
    const params = new URLSearchParams({ systemId: value.systemId });
    if (value.portfolioId) params.set('portfolioId', value.portfolioId);
    if (value.from) params.set('from', value.from);
    if (value.till) params.set('till', value.till);
    return `/api/operations/trades?${params}`;
  }, { parse: z.array(TradeSchema).parse });
}

export type { Trade };
