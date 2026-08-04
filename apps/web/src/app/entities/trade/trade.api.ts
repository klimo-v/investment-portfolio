import { Injectable, inject } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { z } from 'zod';
import { TradeSchema, type Trade } from '@core';
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
  private readonly revision = inject(DataRevision);

  readonly trades = httpResource(
    () => {
      this.revision.value();
      return '/api/operations/trades';
    },
    { parse: z.array(TradeSchema).parse },
  );
}

export type { Trade };
