import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { z } from 'zod';
import type { MergeUndoPlan, SplitPlan, SplitRequest } from '@core';
import { InstrumentIdentifiersSchema, SplitRequestSchema, InstrumentSchema, PortfolioSchema, SystemSchema, type Portfolio, type System } from '@core';
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
/** Тело запроса разделения (до разбора Zod на сервере: поля с умолчаниями необязательны) */
export type SplitRequestInput = z.input<typeof SplitRequestSchema>;

const MergeIssueSchema = z.object({ code: z.string(), message: z.string() });
const MergePreviewSchema = z.object({
  source: z.object({ id: z.string(), ticker: z.string(), name: z.string().nullable() }),
  target: z.object({ id: z.string(), ticker: z.string(), name: z.string().nullable() }),
  blockers: z.array(MergeIssueSchema),
  warnings: z.array(MergeIssueSchema),
  consequences: z.object({ operations: z.number(), prices: z.number(), pricesDiscarded: z.number(), codes: z.number() }),
});
export type MergePreview = z.infer<typeof MergePreviewSchema>;
export type { Portfolio, System };
/** План отката слияния + предпросмотр разделения (ответ POST /instruments/merges/:id/undo-plan) */
export interface MergeUndoView {
  merge: { id: string; at: string; sourceId: string; sourceTicker: string; targetId: string; undone: boolean };
  plan: MergeUndoPlan;
  preview: SplitPlan['preview'] | null;
}
export type { MergeUndoPlan, SplitPlan, SplitRequest };
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
  /** «Привязанные коды» одного инструмента (только чтение) */
  instrumentIdentifiers(instrumentId: string): Promise<InstrumentIdentifiers> {
    return firstValueFrom(this.http.get(`/api/instruments/${instrumentId}/identifiers`)).then((r) => InstrumentIdentifiersSchema.parse(r));
  }

  /** Предпросмотр разделения инструмента — без записи */
  splitPreview(instrumentId: string, request: SplitRequestInput): Promise<SplitPlan> {
    return firstValueFrom(this.http.post<SplitPlan>(`/api/instruments/${instrumentId}/split/preview`, request));
  }

  /** Выделить новый инструмент: переносит выбранные операции и коды. Меняет и справочник, и позиции */
  async splitInstrument(instrumentId: string, request: SplitRequestInput): Promise<{ newInstrumentId: string; movedOperations: number }> {
    const res = await firstValueFrom(
      this.http.post<{ splitId: string; newInstrumentId: string; movedOperations: number }>(
        `/api/instruments/${instrumentId}/split`,
        request,
        withToastSuccess('Инструмент выделен'),
      ),
    );
    this.reloadTrigger.update((n) => n + 1);
    this.revision.bump();
    return res;
  }

  /** План отката слияния; `assignments` — явное распределение неясных операций (список id — в теле POST) */
  undoPlan(mergeId: string, assignments: { toSource: string[]; toTarget: string[] }): Promise<MergeUndoView> {
    return firstValueFrom(this.http.post<MergeUndoView>(`/api/instruments/merges/${mergeId}/undo-plan`, { assignments }));
  }

  async undoMerge(
    mergeId: string,
    body: { assignments: { toSource: string[]; toTarget: string[] }; confirmOrphanSells: boolean },
  ): Promise<void> {
    await firstValueFrom(this.http.post(`/api/instruments/merges/${mergeId}/undo`, body, withToastSuccess('Слияние отменено')));
    this.reloadTrigger.update((n) => n + 1);
    this.revision.bump();
  }

  /** Проверки слияния и последствия — без записи */
  async mergePreview(sourceId: string, targetId: string): Promise<MergePreview> {
    return MergePreviewSchema.parse(
      await firstValueFrom(this.http.get(`/api/instruments/${sourceId}/merge-preview/${targetId}`)),
    );
  }

  async mergeInstruments(
    sourceId: string,
    targetId: string,
    confirmWarnings = false,
  ): Promise<{ merged: true; movedOperations: number }> {
    const result = await firstValueFrom(
      this.http.post<{ merged: true; movedOperations: number }>(
        `/api/instruments/${sourceId}/merge-into/${targetId}`,
        { confirmWarnings },
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
