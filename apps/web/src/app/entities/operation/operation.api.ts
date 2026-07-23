import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { z } from 'zod';
import { PositionSchema, OperationSchema, type Operation, type Position } from '@core';

/**
 * API-клиент операций и позиций (FSD: entities).
 * Чтение — через httpResource (реактивно, на сигналах, с Zod-валидацией ответа).
 * Мутации (POST) — напрямую через HttpClient (CLAUDE.md §3).
 */
@Injectable({ providedIn: 'root' })
export class OperationApi {
  private readonly http = inject(HttpClient);

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

  /** Добавить операцию (мутация через HttpClient), затем перезагрузить ресурсы */
  async add(operation: Operation): Promise<Operation> {
    const created = await new Promise<Operation>((resolve, reject) => {
      this.http.post<Operation>('/api/operations', operation).subscribe({
        next: resolve,
        error: reject,
      });
    });
    this.reloadTrigger.update((n) => n + 1);
    return created;
  }
}

export type { Operation, Position };
