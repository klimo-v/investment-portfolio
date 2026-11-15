import { inject, type Signal } from '@angular/core';
import { httpResource, type HttpResourceRef } from '@angular/common/http';
import { SystemPerformanceSchema, type SystemPerformance } from '@core';
import { DataRevision } from '../../shared/data-revision';

/** Срез статистики системы: портфель и период (система — в пути запроса) */
export interface SystemPerformanceFilter {
  portfolioId?: string;
  from?: string;
  till?: string;
}

function performanceUrl(systemId: string, filter: SystemPerformanceFilter): string {
  const params = new URLSearchParams();
  if (filter.portfolioId) params.set('portfolioId', filter.portfolioId);
  if (filter.from) params.set('from', filter.from);
  if (filter.till) params.set('till', filter.till);
  const qs = params.toString();
  const base = `/api/systems/${encodeURIComponent(systemId)}/performance`;
  return qs ? `${base}?${qs}` : base;
}

/**
 * Статистика торговой системы (FSD: entities). Функция в контексте инъекции, как
 * `summaryResource`: система и фильтр приходят сигналами и читаются лениво внутри
 * URL-функции — первый же запрос уходит с правильными параметрами. Ответ проверяется
 * Zod-схемой общего контракта (`@core`). `DataRevision` перезапрашивает данные после
 * мутаций журнала (импорт, правка операции).
 */
export function systemPerformanceResource(
  systemId: Signal<string>,
  filter: Signal<SystemPerformanceFilter | null>,
): HttpResourceRef<SystemPerformance | undefined> {
  const revision = inject(DataRevision);
  return httpResource(
    () => {
      revision.value();
      const current = filter();
      return current ? performanceUrl(systemId(), current) : undefined;
    },
    { parse: SystemPerformanceSchema.parse },
  );
}

export type { SystemPerformance };
