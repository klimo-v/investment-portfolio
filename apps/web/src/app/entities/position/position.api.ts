import { Injectable, inject } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { z } from 'zod';
import { PositionSchema, type Position } from '@core';
import { DataRevision } from '../../shared/data-revision';

/**
 * Рассчитанные позиции портфеля (FSD: entities). Считает движок `@core` на бэке —
 * здесь только чтение с Zod-валидацией ответа.
 *
 * Отдельный сервис, а не поле в `OperationApi`: httpResource запрашивает при
 * создании, и общий сервис заставлял «Сделки» грузить позиции, а «Портфель» —
 * сделки. Инвалидация после мутаций общая (DataRevision).
 */
@Injectable({ providedIn: 'root' })
export class PositionApi {
  private readonly revision = inject(DataRevision);

  readonly positions = httpResource(
    () => {
      this.revision.value();
      return '/api/operations/positions';
    },
    { parse: z.array(PositionSchema).parse },
  );
}

export type { Position };
