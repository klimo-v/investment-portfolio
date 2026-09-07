import { Injectable, inject } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { z } from 'zod';
import {
  SnapshotSchema,
  SnapshotStalenessSchema,
  type Snapshot,
  type SnapshotStaleness,
} from '@core';
import { withToastSuccess } from '@web-shared';
import { DataRevision } from '../../shared/data-revision';

/**
 * API-клиент снимков стоимости портфеля (FSD: entities, docs/04-roadmap.md Фаза 5).
 *
 * Снимок снимается ОСОЗНАННО — кнопкой «Сделать снимок» у графика «Стоимость
 * инструментов во времени» на дашборде. Раньше он был побочным эффектом «Обновить
 * цены» на странице «Портфель»: график рос молча и не там, где на него смотрят.
 *
 * Правка журнала операций задним числом историю снимков больше не стирает — бэкенд
 * пишет, что именно изменилось, а `staleness` отдаёт это фронту (иконка-предупреждение
 * + таблица изменений в модалке). Снять предупреждение можно двумя способами:
 * acknowledge() — «видел, скрыть», clearHistory() — стереть историю целиком.
 *
 * Инвалидация ресурсов — общий DataRevision: свой приватный триггер здесь разъезжался
 * с PositionSeriesApi, из-за чего график не обновлялся после нового снимка вовсе.
 */
@Injectable({ providedIn: 'root' })
export class SnapshotApi {
  private readonly http = inject(HttpClient);
  private readonly revision = inject(DataRevision);

  /** История снимков по датам — для линии динамики на дашборде */
  readonly list = httpResource(
    () => {
      this.revision.value();
      return '/api/snapshots';
    },
    { parse: z.array(SnapshotSchema).parse },
  );

  /** Достоверность истории: с какой даты снимкам нельзя доверять и что изменилось */
  readonly staleness = httpResource(
    () => {
      this.revision.value();
      return '/api/snapshots/staleness';
    },
    { parse: SnapshotStalenessSchema.parse },
  );

  /** Снять снимок на сегодня (повторный клик в тот же день обновит точку дня) */
  async capture(): Promise<void> {
    await firstValueFrom(
      this.http.post<Snapshot>('/api/snapshots/capture', {}, withToastSuccess('Снимок сохранён')),
    );
    this.revision.bump();
  }

  /** «Понятно, скрыть» — предупреждение гаснет, история снимков остаётся */
  async acknowledge(): Promise<void> {
    await firstValueFrom(
      this.http.post<{ acknowledged: number }>(
        '/api/snapshots/acknowledge',
        {},
        withToastSuccess('Предупреждение скрыто'),
      ),
    );
    this.revision.bump();
  }

  /** Стереть накопленную историю снимков вместе с журналом изменений (необратимо) */
  async clearHistory(): Promise<void> {
    await firstValueFrom(
      this.http.delete<{ deleted: true }>(
        '/api/snapshots',
        withToastSuccess('История снимков очищена'),
      ),
    );
    this.revision.bump();
  }
}

export type { Snapshot, SnapshotStaleness };
