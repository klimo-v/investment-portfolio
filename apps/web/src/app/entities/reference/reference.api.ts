import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { z } from 'zod';
import { InstrumentSchema, PortfolioSchema, type Portfolio } from '@core';

/**
 * API-клиент справочников (FSD: entities): системы, портфели, инструменты.
 * Нужны форме ввода операции для выпадающих списков/автокомплита.
 */

export const SystemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
});
export type System = z.infer<typeof SystemSchema>;

/** Портфель из БД — id всегда есть (в отличие от тела создания в @core) */
const PortfolioRowSchema = PortfolioSchema.required({ id: true });

export type Instrument = z.infer<typeof InstrumentSchema>;
export type { Portfolio };

@Injectable({ providedIn: 'root' })
export class ReferenceApi {
  private readonly http = inject(HttpClient);

  /** триггер перезагрузки: меняем значение → httpResource перезапрашивает */
  private readonly reloadTrigger = signal(0);

  readonly systems = httpResource(() => '/api/systems', {
    parse: z.array(SystemSchema).parse,
  });

  readonly portfolios = httpResource(
    () => {
      this.reloadTrigger();
      return '/api/portfolios';
    },
    { parse: z.array(PortfolioRowSchema).parse },
  );

  readonly instruments = httpResource(() => '/api/instruments', {
    parse: z.array(InstrumentSchema).parse,
  });

  /** Создать портфель, затем перезагрузить список */
  async createPortfolio(portfolio: Portfolio): Promise<Portfolio> {
    const created = await firstValueFrom(
      this.http.post<Portfolio>('/api/portfolios', portfolio),
    );
    this.reloadTrigger.update((n) => n + 1);
    return created;
  }

  /** Удалить портфель (только если на него не ссылаются операции), затем перезагрузить список */
  async deletePortfolio(id: string): Promise<void> {
    await firstValueFrom(this.http.delete<{ deleted: true }>(`/api/portfolios/${id}`));
    this.reloadTrigger.update((n) => n + 1);
  }
}
