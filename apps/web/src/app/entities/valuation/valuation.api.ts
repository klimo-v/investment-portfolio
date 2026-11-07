import { inject, type Signal } from '@angular/core';
import { httpResource, type HttpResourceRef } from '@angular/common/http';
import { timeWeightedIndex, ValuationSeriesSchema, type ValuationSeriesDto } from '@core';
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
  filter: Signal<ValuationFilter>,
): HttpResourceRef<ValuationSeriesDto | undefined> {
  const revision = inject(DataRevision);
  return httpResource(
    () => {
      revision.value();
      return valuationUrl(filter());
    },
    { parse: ValuationSeriesSchema.parse },
  );
}

/** Точка суммарного ряда: поле по всем группам на дату */
export interface TotalPoint {
  date: string;
  valueRub: number;
}

/**
 * Сумма поля по всем группам на каждый день — ряд «портфель целиком». Деньги в ряду —
 * decimal-строки; число нужно только для отрисовки графика, расчётов на нём нет.
 */
export function totalSeries(
  series: ValuationSeriesDto | undefined,
  field: 'marketValueRub' | 'investedRub' | 'totalRub' | 'fixedRub' | 'unrealizedRub',
): TotalPoint[] {
  const first = series?.groups[0];
  if (!series || !first) return [];
  return first.points.map((p, i) => ({
    date: p.date,
    valueRub: series.groups.reduce((s, g) => s + Number(g.points[i][field]), 0),
  }));
}

/**
 * Индекс доходности портфеля (база 100), очищенный от ввода/вывода денег и продаж
 * (timeWeightedIndex из @core). По нему считаются просадка и линия «Портфель» против рынка:
 * ряд рыночной стоимости для этого не годится — продажа и довнесение двигают его без
 * всякого результата.
 */
export function portfolioIndex(series: ValuationSeriesDto | undefined): TotalPoint[] {
  const totals = totalSeries(series, 'totalRub');
  if (!series || totals.length === 0) return [];
  const index = timeWeightedIndex(
    totals.map((t, i) => ({ totalRub: t.valueRub, netContributionsRub: Number(series.netContributionsRub[i] ?? 0) })),
  );
  return totals.map((t, i) => ({ date: t.date, valueRub: index[i] }));
}

export type { ValuationSeriesDto };
