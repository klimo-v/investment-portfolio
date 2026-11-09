import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { z } from 'zod';
import { InstrumentIdentifiersSchema, InstrumentSchema, PortfolioSchema, SystemSchema, type Portfolio, type System } from '@core';
import { withToastSuccess } from '@web-shared';
import { DataRevision } from '../../shared/data-revision';

/**
 * API-клиент справочников (FSD: entities): системы, портфели, инструменты.
 * Нужны форме ввода операции для выпадающих списков/автокомплита.
 */

/** Портфель/система из БД — id всегда есть (в отличие от тела создания в @core) */
const PortfolioRowSchema = PortfolioSchema.required({ id: true });
const SystemRowSchema = SystemSchema.required({ id: true });

export type Instrument = z.infer<typeof InstrumentSchema>;

/** Пара возможных дублей справочника с предложенным направлением слияния (source → target) */
const PossibleDuplicateSchema = z.object({
  sourceId: z.string(),
  sourceTicker: z.string(),
  sourceName: z.string().nullable(),
  targetId: z.string(),
  targetTicker: z.string(),
  targetName: z.string().nullable(),
  type: z.string(),
  reason: z.string(),
  /** тикеры совпали после нормализации — слияние безопасно */
  deterministic: z.boolean(),
});
export type PossibleDuplicate = z.infer<typeof PossibleDuplicateSchema>;
export type { Portfolio, System };
export type InstrumentIdentifiers = z.infer<typeof InstrumentIdentifiersSchema>;

@Injectable({ providedIn: 'root' })
export class ReferenceApi {
  private readonly http = inject(HttpClient);
  private readonly revision = inject(DataRevision);

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

  readonly instruments = httpResource(
    () => {
      this.reloadTrigger();
      return '/api/instruments';
    },
    { parse: z.array(InstrumentSchema).parse },
  );

  /** «Возможные дубли»: похожие инструменты (эвристики core), решение остаётся за пользователем */
  readonly possibleDuplicates = httpResource(
    () => {
      this.reloadTrigger();
      return '/api/instruments/possible-duplicates';
    },
    { parse: z.array(PossibleDuplicateSchema).parse },
  );

  /** «Привязанные коды»: инструменты со слитыми кодами или подозрительным набором (только чтение) */
  readonly mergedIdentifiers = httpResource(
    () => {
      this.reloadTrigger();
      this.revision.value();
      return '/api/instruments/merged-identifiers';
    },
    { parse: z.array(InstrumentIdentifiersSchema).parse },
  );

  /** Создать портфель, затем перезагрузить список */
  async createPortfolio(portfolio: Portfolio): Promise<Portfolio> {
    const created = await firstValueFrom(
      this.http.post<Portfolio>('/api/portfolios', portfolio, withToastSuccess('Портфель создан')),
    );
    this.reloadTrigger.update((n) => n + 1);
    return created;
  }

  /** Удалить портфель (только если на него не ссылаются операции), затем перезагрузить список */
  async deletePortfolio(id: string): Promise<void> {
    await firstValueFrom(
      this.http.delete<{ deleted: true }>(`/api/portfolios/${id}`, withToastSuccess('Портфель удалён')),
    );
    this.reloadTrigger.update((n) => n + 1);
  }

  /** Создать систему, затем перезагрузить список */
  async createSystem(system: System): Promise<System> {
    const created = await firstValueFrom(
      this.http.post<System>('/api/systems', system, withToastSuccess('Система создана')),
    );
    this.reloadTrigger.update((n) => n + 1);
    return created;
  }

  /** Удалить систему (только если на неё не ссылаются операции), затем перезагрузить список */
  async deleteSystem(id: string): Promise<void> {
    await firstValueFrom(
      this.http.delete<{ deleted: true }>(`/api/systems/${id}`, withToastSuccess('Система удалена')),
    );
    this.reloadTrigger.update((n) => n + 1);
  }

  /**
   * Слить дубль-инструмент (sourceId) в другой (targetId): его операции переходят
   * на targetId, сам он удаляется из справочника. Нужен для случаев вроде
   * TMON@/TMON — брокерский импорт заводит два инструмента на один реальный актив
   * под разными кодами, а автоматически распознать дубль нельзя (см. диалог).
   * Затрагивает и позиции/сделки (DataRevision), и сам справочник (reloadTrigger).
   */
  async mergeInstruments(
    sourceId: string,
    targetId: string,
  ): Promise<{ merged: true; movedOperations: number }> {
    const result = await firstValueFrom(
      this.http.post<{ merged: true; movedOperations: number }>(
        `/api/instruments/${sourceId}/merge-into/${targetId}`,
        {},
        withToastSuccess('Инструменты объединены'),
      ),
    );
    this.reloadTrigger.update((n) => n + 1);
    this.revision.bump();
    return result;
  }

  /**
   * Найти цену через подключённые провайдеры (MOEX/Binance) для инструмента без
   * автоисточника (marketSource='manual') — файловый импорт заводит так любой
   * новый тикер из осторожности, даже если бумага реально торгуется на бирже
   * под тем же кодом (см. GOLD). Успех переключает marketSource у инструмента —
   * поэтому перечитываем и справочник, и позиции.
   */
  async resolvePrice(instrumentId: string): Promise<{ price: string; source: string }> {
    const result = await firstValueFrom(
      this.http.post<{ price: string; source: string }>(
        `/api/quotes/${instrumentId}/resolve`,
        {},
        withToastSuccess('Цена найдена'),
      ),
    );
    this.reloadTrigger.update((n) => n + 1);
    this.revision.bump();
    return result;
  }
}
