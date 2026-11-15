import { inject, type Signal } from '@angular/core';
import { httpResource, type HttpResourceRef } from '@angular/common/http';
import { DashboardSummarySchema, type DashboardSummary } from '@core';
import { DataRevision } from '../../shared/data-revision';

/** Фильтр сводки (docs/05-review-usability.md §2): система / портфель / период */
export interface SummaryFilter {
  systemId?: string;
  portfolioId?: string;
  from?: string;
  till?: string;
}

function summaryUrl(filter: SummaryFilter): string {
  const params = new URLSearchParams();
  if (filter.systemId) params.set('systemId', filter.systemId);
  if (filter.portfolioId) params.set('portfolioId', filter.portfolioId);
  if (filter.from) params.set('from', filter.from);
  if (filter.till) params.set('till', filter.till);
  const qs = params.toString();
  return qs ? `/api/operations/summary?${qs}` : '/api/operations/summary';
}

/**
 * Агрегаты дашборда под ФИЛЬТР СТРАНИЦЫ (FSD: entities). Функция, а не
 * `@Injectable`, и вызывается страницей в контексте инъекции — как `mediaQuery()`
 * из web-shared.
 *
 * Почему не сервис с общим `summaryFilter`, как было раньше: тот сигнал жил в
 * root-сервисе, а писали в него ЭФФЕКТАМИ сразу две страницы. Из-за этого
 * фильтры затирали друг друга при навигации (портфель писал без периода), и на
 * каждый вход на страницу уходил лишний запрос — ресурс успевал сходить с
 * фильтром предыдущей страницы, потом эффект менял URL и вызывал перезапрос.
 *
 * Здесь фильтр приходит готовым сигналом и читается ЛЕНИВО, уже внутри
 * URL-функции ресурса: первый же запрос уходит с правильными параметрами, эффект
 * не нужен, а состояние живёт ровно столько, сколько живёт страница.
 */
export function summaryResource(
  filter: Signal<SummaryFilter | null>,
): HttpResourceRef<DashboardSummary | undefined> {
  const revision = inject(DataRevision);
  return httpResource(
    () => {
      revision.value();
      const current = filter();
      return current ? summaryUrl(current) : undefined;
    },
    { parse: DashboardSummarySchema.parse },
  );
}

export type { DashboardSummary };
