import { inject, type Signal } from '@angular/core';
import { httpResource, type HttpResourceRef } from '@angular/common/http';
import { BenchmarkResponseSchema, type BenchmarkResponse, type BenchmarkSeriesDto } from '@core';
import { DataRevision } from '../../shared/data-revision';

/** Что и за какой период сравниваем с портфелем */
export interface BenchmarkQuery {
  secid: string;
  from: string;
  till: string;
}

/**
 * Ориентир для линии «Портфель против рынка» (GET /api/benchmark): выбранный индекс и линия
 * «Денежный рынок» на базе 100 на первый день периода. Ряды строит бэк из price_history —
 * фронт только рисует. Запрос приходит сигналом от страницы (период берётся из ряда TWR) и
 * читается лениво внутри URL-функции: пока он null, ресурс простаивает и запрос не уходит.
 */
export function benchmarkResource(
  query: Signal<BenchmarkQuery | null>,
): HttpResourceRef<BenchmarkResponse | undefined> {
  const revision = inject(DataRevision);
  return httpResource(
    () => {
      revision.value();
      const q = query();
      return q ? `/api/benchmark?secid=${q.secid}&from=${q.from}&till=${q.till}` : undefined;
    },
    { parse: BenchmarkResponseSchema.parse },
  );
}

export type { BenchmarkResponse, BenchmarkSeriesDto };
