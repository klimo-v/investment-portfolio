import type { Signal } from '@angular/core';
import { httpResource, type HttpResourceRef } from '@angular/common/http';
import { z } from 'zod';
import { BenchmarkPointSchema, type BenchmarkPoint } from '@core';

/** Диапазон дат запроса истории индекса */
export interface BenchmarkRange {
  from: string;
  till: string;
}

/**
 * История бенчмарка (индекс IMOEX) для линии «Портфель vs рынок» на дашборде
 * (docs/05-review-usability.md §1). Диапазон приходит сигналом от страницы (он
 * считается по датам ряда стоимости) и читается ЛЕНИВО внутри URL-функции: пока он null,
 * httpResource простаивает на undefined-URL и запрос не уходит.
 *
 * Функция, а не root-сервис с публичным `range`: у сервиса значение переживало
 * уход со страницы, и при возврате ресурс успевал сходить со СТАРЫМ диапазоном
 * прежде, чем эффект страницы записывал новый.
 */
export function benchmarkResource(
  range: Signal<BenchmarkRange | null>,
): HttpResourceRef<BenchmarkPoint[] | undefined> {
  return httpResource(
    () => {
      const r = range();
      return r ? `/api/quotes/benchmark?from=${r.from}&till=${r.till}` : undefined;
    },
    { parse: z.array(BenchmarkPointSchema).parse },
  );
}

export type { BenchmarkPoint };
