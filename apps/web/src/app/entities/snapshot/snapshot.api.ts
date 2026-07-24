import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { z } from 'zod';
import { SnapshotSchema, type Snapshot } from '@core';

/**
 * API-клиент снимков стоимости портфеля (FSD: entities, docs/04-roadmap.md
 * Фаза 5). Снимок пишется вызовом capture() — вызывается из
 * OperationApi.refreshQuotes(), сразу после обновления котировок, чтобы
 * снимок отражал свежую стоимость, а не старую.
 */
@Injectable({ providedIn: 'root' })
export class SnapshotApi {
  private readonly http = inject(HttpClient);

  private readonly reloadTrigger = signal(0);

  /** История снимков по датам — для линии динамики на дашборде */
  readonly list = httpResource(
    () => {
      this.reloadTrigger();
      return '/api/snapshots';
    },
    { parse: z.array(SnapshotSchema).parse },
  );

  /** Снять снимок на сегодня и перечитать историю */
  async capture(): Promise<void> {
    await firstValueFrom(this.http.post<Snapshot>('/api/snapshots/capture', {}));
    this.reloadTrigger.update((n) => n + 1);
  }
}

export type { Snapshot };
