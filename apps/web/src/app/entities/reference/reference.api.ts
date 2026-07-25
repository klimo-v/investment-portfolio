import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { z } from 'zod';
import { InstrumentSchema, PortfolioSchema, SystemSchema, type Portfolio, type System } from '@core';

/**
 * API-клиент справочников (FSD: entities): системы, портфели, инструменты.
 * Нужны форме ввода операции для выпадающих списков/автокомплита.
 */

/** Портфель/система из БД — id всегда есть (в отличие от тела создания в @core) */
const PortfolioRowSchema = PortfolioSchema.required({ id: true });
const SystemRowSchema = SystemSchema.required({ id: true });

export type Instrument = z.infer<typeof InstrumentSchema>;
export type { Portfolio, System };

@Injectable({ providedIn: 'root' })
export class ReferenceApi {
  private readonly http = inject(HttpClient);

  /** триггер перезагрузки: меняем значение → httpResource перезапрашивает */
  private readonly reloadTrigger = signal(0);

  readonly systems = httpResource(
    () => {
      this.reloadTrigger();
      return '/api/systems';
    },
    { parse: z.array(SystemRowSchema).parse },
  );

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

  /** Создать систему, затем перезагрузить список */
  async createSystem(system: System): Promise<System> {
    const created = await firstValueFrom(this.http.post<System>('/api/systems', system));
    this.reloadTrigger.update((n) => n + 1);
    return created;
  }

  /** Удалить систему (только если на неё не ссылаются операции), затем перезагрузить список */
  async deleteSystem(id: string): Promise<void> {
    await firstValueFrom(this.http.delete<{ deleted: true }>(`/api/systems/${id}`));
    this.reloadTrigger.update((n) => n + 1);
  }
}
