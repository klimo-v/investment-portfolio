import { inject, type Signal } from '@angular/core';
import { httpResource, type HttpResourceRef } from '@angular/common/http';
import { ValuationSeriesSchema, type ValuationSeriesDto } from '@core';
import { DataRevision } from '../../shared/data-revision';

/** Фильтр дневного ряда оценки: система / портфель / период (как у сводки дашборда) */
export interface ValuationFilter {
  groupBy: 'portfolio' | 'system' | 'instrument';
  systemId?: string;
  portfolioId?: string;
  from?: string;
  till?: string;
}

function valuationUrl(filter: ValuationFilter): string {
  const params = new URLSearchParams({ groupBy: filter.groupBy });
  if (filter.systemId) params.set('systemId', filter.systemId);
  if (filter.portfolioId) params.set('portfolioId', filter.portfolioId);
  if (filter.from) params.set('from', filter.from);
  if (filter.till) params.set('till', filter.till);
  return `/api/valuation/series?${params.toString()}`;
}

/**
 * Дневной ряд оценки (GET /api/valuation/series) — единственный источник графиков
 * динамики на дашборде: стоимость инструментов во времени, портфель против рынка,
 * просадка. Ряд считается из журнала и истории цен на каждый запрос, ничего не хранится,
 * поэтому правка журнала задним числом сразу отражается в графиках.
 *
 * Фильтр читается лениво внутри URL-функции (как в summaryResource), а DataRevision
 * перезапрашивает ряд после любой записи (операция, импорт, «Обновить цены»).
 */
export function valuationResource(
  filter: Signal<ValuationFilter | null>,
): HttpResourceRef<ValuationSeriesDto | undefined> {
  const revision = inject(DataRevision);
  return httpResource(
    () => {
      revision.value();
      const current = filter();
      return current ? valuationUrl(current) : undefined;
    },
    { parse: ValuationSeriesSchema.parse },
  );
}

export type { ValuationSeriesDto };
