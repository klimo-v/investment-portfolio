import { Injectable, inject, type Signal } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { z } from 'zod';
import { Yv1OverviewSchema, type StrategySummary, type Yv1CycleView, type Yv1Overview } from '@core';
import { withToastSuccess } from '@web-shared';
import { DataRevision } from '../../shared/data-revision';
import { StrategyListApi } from './strategy-list.api';

/** Сводка последнего обновления — то, что вернул POST /api/strategies/:systemId/refresh */
export const Yv1RefreshReportSchema = z.object({
  at: z.string(),
  snapshots: z.object({
    total: z.number(),
    imported: z.array(z.string()),
    alreadyImported: z.number(),
    incomplete: z.array(z.object({ snapId: z.string(), reasons: z.array(z.string()) })),
    unfinished: z.array(z.string()),
    conflicts: z.array(z.string()),
  }),
  automat: z.object({
    trades: z.number(),
    days: z.number(),
    signals: z.number(),
    logs: z.number(),
    missingFiles: z.array(z.string()),
    skipped: z.array(z.string()),
  }),
  resultDays: z.number(),
});
export type Yv1RefreshReport = z.infer<typeof Yv1RefreshReportSchema>;

export const Yv1SettingsSchema = z.object({
  initialCapital: z.string().nullable(),
  feeRounding: z.enum(['ceil', 'half-up']),
  debtRatePerDay: z.string(),
  backtestScale: z.string().nullable(),
});
export type Yv1Settings = z.infer<typeof Yv1SettingsSchema>;

/**
 * API-клиент стратегий (FSD: entities). Чтение — httpResource + Zod-схема из @core
 * (контракт общий с бэкендом), мутации — напрямую через HttpClient, после них общий
 * DataRevision перезапрашивает обзор. Все операции — по `systemId` стратегии.
 */
@Injectable({ providedIn: 'root' })
export class StrategyApi {
  private readonly http = inject(HttpClient);
  private readonly revision = inject(DataRevision);
  private readonly strategyList = inject(StrategyListApi);

  /**
   * Завести стратегию: существующая система (`systemId`) или новая (`name`), портфель и префикс
   * журнала автомата. Возвращает созданную стратегию; список в меню обновляется через DataRevision.
   */
  async create(body: NewStrategyBody): Promise<StrategySummary> {
    const created = await firstValueFrom(
      this.http.post<StrategySummary>('/api/strategies', body, withToastSuccess('Стратегия создана')),
    );
    this.strategyList.reload();
    return created;
  }

  /**
   * Удалить стратегию вместе с журналом, настройками и результатом в портфеле. Систему и снимки
   * моста не трогает. `force` — подтверждение необратимого удаления (без него сервер откажет,
   * если у стратегии есть данные).
   *
   * Данные здесь намеренно НЕ инвалидируются: страница удалённой стратегии ещё жива, и общий
   * bump заставил бы её обзор перезапроситься по несуществующему id (404 и лишний тост).
   * Вызывающий сначала уходит со страницы, затем вызывает `invalidateAfterRemoval()`.
   */
  async remove(systemId: string, force: boolean): Promise<void> {
    await firstValueFrom(
      this.http.delete(this.base(systemId), { params: { force }, ...withToastSuccess('Стратегия удалена') }),
    );
  }

  /** Перезапросить список стратегий и данные портфеля — результат удалённой стратегии пропал из итогов */
  invalidateAfterRemoval(): void {
    this.strategyList.reload();
    this.revision.bump();
  }

  /** Обзор одной стратегии; ресурс перезапрашивается при смене `systemId` и после мутаций */
  overview(systemId: Signal<string>) {
    return httpResource(
      () => {
        this.revision.value();
        return `/api/strategies/${encodeURIComponent(systemId())}/overview`;
      },
      { parse: Yv1OverviewSchema.parse },
    );
  }

  /** Прочитать источник данных в БД (идемпотентно) */
  async refresh(systemId: string): Promise<Yv1RefreshReport> {
    const report = await firstValueFrom(
      this.http.post<unknown>(`${this.base(systemId)}/refresh`, {}, withToastSuccess('Источник обновлён')),
    );
    this.revision.bump();
    return Yv1RefreshReportSchema.parse(report);
  }

  /** Знаменатель и модельные параметры; null сбрасывает значение */
  async saveSettings(systemId: string, patch: Partial<Yv1Settings>): Promise<void> {
    await firstValueFrom(this.http.put(`${this.base(systemId)}/settings`, patch, withToastSuccess('Настройки сохранены')));
    this.revision.bump();
  }

  /** Ссылка на выгрузку фактической кривой `date,ret,equity` */
  curveCsvUrl(systemId: string): string {
    return `${this.base(systemId)}/curve.csv`;
  }

  private base(systemId: string): string {
    return `/api/strategies/${encodeURIComponent(systemId)}`;
  }
}

/** Тело `POST /api/strategies`: либо `systemId`, либо `name` */
export interface NewStrategyBody {
  systemId?: string;
  name?: string;
  portfolioId: string;
  params: { journalPrefix: string };
}

export type { StrategySummary, Yv1CycleView, Yv1Overview };
