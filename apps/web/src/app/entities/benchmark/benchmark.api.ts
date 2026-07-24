import { Injectable, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { z } from 'zod';
import { BenchmarkPointSchema, type BenchmarkPoint } from '@core';

/**
 * API-клиент истории бенчмарка (индекс IMOEX) для линии «Портфель vs рынок»
 * на дашборде (docs/05-review-usability.md §1). Диапазон дат задаётся снаружи
 * (по датам снимков стоимости) — пока не задан, запрос не уходит (httpResource
 * с undefined-URL простаивает).
 */
@Injectable({ providedIn: 'root' })
export class BenchmarkApi {
  /** Диапазон запроса; null — не запрашивать (нет снимков) */
  readonly range = signal<{ from: string; till: string } | null>(null);

  readonly history = httpResource(
    () => {
      const r = this.range();
      if (!r) return undefined;
      return `/api/quotes/benchmark?from=${r.from}&till=${r.till}`;
    },
    { parse: z.array(BenchmarkPointSchema).parse },
  );
}

export type { BenchmarkPoint };
