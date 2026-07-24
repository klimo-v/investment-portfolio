import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { Operation } from '@core';

/**
 * API-клиент импорта (FSD: entities). Только мутации → HttpClient.
 */

export interface PreviewRow {
  operation?: Operation;
  confidence: 'ok' | 'warn' | 'error' | 'duplicate';
  reason?: string;
  /** Признак счёта из отчёта (docs/04-roadmap.md §3.1) */
  accountRef?: string;
  /** Тикер строки (для выбора системы по тикеру в рамках этого импорта, §3.1) */
  ticker?: string;
  /** Система назначена батч-дефолтом, а не выбрана явно для этого тикера — стоит проверить (§3.1) */
  systemUncertain?: boolean;
}

export interface PreviewResult {
  rows: PreviewRow[];
  summary: { total: number; ok: number; warn: number; error: number; duplicate: number };
}

export type ImportFormat = 'csv' | 'html' | 'xlsx';

/**
 * Разметка на весь батч: формат файла + портфель/система (для отчётов брокеров).
 * `tickerSystemOverrides` — точечный выбор системы по тикеру для ЭТОГО импорта
 * (docs/04-roadmap.md §3.1): один и тот же тикер в разное время может относиться
 * к разным системам, поэтому ничего не запоминается между импортами — карта живёт
 * только в текущей сессии страницы и сбрасывается при загрузке нового файла.
 */
export interface ImportOptions {
  format: ImportFormat;
  systemId?: string;
  portfolioId?: string;
  tickerSystemOverrides?: Record<string, string>;
}

@Injectable({ providedIn: 'root' })
export class ImportApi {
  private readonly http = inject(HttpClient);

  preview(content: string, opts: ImportOptions): Promise<PreviewResult> {
    return firstValueFrom(
      this.http.post<PreviewResult>('/api/import/preview', { content, ...opts }),
    );
  }

  commit(content: string, opts: ImportOptions): Promise<{ batchId: string; imported: number }> {
    return firstValueFrom(
      this.http.post<{ batchId: string; imported: number }>('/api/import/commit', {
        content,
        ...opts,
      }),
    );
  }

  rollback(batchId: string): Promise<{ deleted: number }> {
    return firstValueFrom(
      this.http.post<{ deleted: number }>('/api/import/rollback', { batchId }),
    );
  }
}
