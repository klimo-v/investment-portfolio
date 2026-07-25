import { Injectable } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { PositionSeriesSchema, type PositionSeries } from '@core';

/**
 * API-клиент ряда «стоимость инструментов во времени» (FSD: entities) для
 * мульти-линейного графика на дашборде. Ряд читается из snapshot_positions
 * (GET /snapshots/positions) — снимки копятся день за днём при «Обновить цены»
 * (SnapshotApi.capture), исторических цен не реконструируем.
 */
@Injectable({ providedIn: 'root' })
export class PositionSeriesApi {
  readonly series = httpResource(() => '/api/snapshots/positions', {
    parse: PositionSeriesSchema.parse,
  });
}

export type { PositionSeries };
