import { inject, type Signal } from '@angular/core';
import { httpResource, type HttpResourceRef } from '@angular/common/http';
import { PerformanceSchema, type PerformanceDto, type PeriodPerformanceDto } from '@core';
import { DataRevision } from '../../shared/data-revision';

/** Контур расчёта: весь журнал, один счёт или одна система (опционально в пределах счёта) */
export interface PerformanceFilter {
  scope: 'all' | 'portfolio' | 'system';
  id?: string;
  portfolioId?: string;
  from?: string;
  till?: string;
}

function performanceUrl(filter: PerformanceFilter): string {
  const params = new URLSearchParams({ scope: filter.scope });
  if (filter.id) params.set('id', filter.id);
  if (filter.portfolioId) params.set('portfolioId', filter.portfolioId);
  if (filter.from) params.set('from', filter.from);
  if (filter.till) params.set('till', filter.till);
  return `/api/performance?${params.toString()}`;
}

/**
 * Доходность за период (GET /api/performance) — единственный источник цифр доходности на
 * дашборде: результат ₽, TWR (он же линия «Портфель против рынка» и просадка), доходность
 * денег, таблица по системам и портфелям. Фронт ничего не пересчитывает, только рисует DTO.
 *
 * Фильтр читается лениво внутри URL-функции (как в summaryResource); DataRevision
 * перезапрашивает расчёт после любой записи (операция, импорт, «Обновить цены»).
 */
export function performanceResource(
  filter: Signal<PerformanceFilter | null>,
): HttpResourceRef<PerformanceDto | undefined> {
  const revision = inject(DataRevision);
  return httpResource(
    () => {
      revision.value();
      const current = filter();
      return current ? performanceUrl(current) : undefined;
    },
    { parse: PerformanceSchema.parse },
  );
}

export type { PerformanceDto, PeriodPerformanceDto };
