import { Injectable, inject } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { PositionSeriesSchema, type PositionSeries } from '@core';
import { DataRevision } from '../../shared/data-revision';

/**
 * API-клиент ряда «стоимость инструментов во времени» (FSD: entities) для
 * мульти-линейного графика на дашборде. Ряд читается из snapshot_positions
 * (GET /snapshots/positions) — снимки пишет SnapshotApi.capture() по кнопке
 * «Сделать снимок»; исторических цен не реконструируем.
 *
 * URL-функция читает DataRevision — без этого она не зависела НИ ОТ ЧЕГО, и свежий
 * снимок появлялся на графике только после полной перезагрузки страницы.
 */
@Injectable({ providedIn: 'root' })
export class PositionSeriesApi {
  private readonly revision = inject(DataRevision);

  readonly series = httpResource(
    () => {
      this.revision.value();
      return '/api/snapshots/positions';
    },
    { parse: PositionSeriesSchema.parse },
  );
}

export type { PositionSeries };
