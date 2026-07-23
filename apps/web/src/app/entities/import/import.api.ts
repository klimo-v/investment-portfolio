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
}

export interface PreviewResult {
  rows: PreviewRow[];
  summary: { total: number; ok: number; warn: number; error: number; duplicate: number };
}

@Injectable({ providedIn: 'root' })
export class ImportApi {
  private readonly http = inject(HttpClient);

  preview(csv: string): Promise<PreviewResult> {
    return firstValueFrom(this.http.post<PreviewResult>('/api/import/preview', { csv }));
  }

  commit(csv: string): Promise<{ batchId: string; imported: number }> {
    return firstValueFrom(
      this.http.post<{ batchId: string; imported: number }>('/api/import/commit', { csv }),
    );
  }

  rollback(batchId: string): Promise<{ deleted: number }> {
    return firstValueFrom(
      this.http.post<{ deleted: number }>('/api/import/rollback', { batchId }),
    );
  }
}
