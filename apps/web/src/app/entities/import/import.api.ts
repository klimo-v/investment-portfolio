import { Injectable, inject } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { z } from 'zod';
import type { Operation } from '@core';
import { withToastSuccess } from '@web-shared';

/**
 * API-клиент импорта (FSD: entities). Мутации → HttpClient, чтения → httpResource.
 */

/** Что изменится в существующей операции при подтверждении («было → станет») */
export interface FieldChange {
  field: 'fee' | 'price' | 'quantity' | 'executedAt';
  from: string | null;
  to: string;
}

export interface PreviewRow {
  operation?: Operation;
  /** 'update' — операция уже есть, но брокер прислал другие значения: обновим, а не задвоим */
  confidence: 'ok' | 'warn' | 'error' | 'duplicate' | 'update';
  existingId?: string;
  changes?: FieldChange[];
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
  summary: { total: number; ok: number; warn: number; error: number; duplicate: number; update: number };
  /** Id уже распарсенного на сервере файла — передать в следующий preview()/commit() вместо content */
  uploadId: string;
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
  /** Формат исходного файла. Для строк, пришедших из API брокера, его нет */
  format?: ImportFormat;
  systemId?: string;
  portfolioId?: string;
  tickerSystemOverrides?: Record<string, string>;
}

/**
 * Что переслать на бэк: либо `content` (первый вызов на файл), либо `uploadId`
 * из ответа предыдущего preview() — тогда бэк переиспользует уже распарсенные
 * строки вместо повторной пересылки/разбора всего файла (важно для больших
 * xlsx-отчётов: правка портфеля/системы/тикер-выбора иначе гоняла бы файл целиком
 * на каждый чих).
 */
export type ImportRequest = { content?: string; uploadId?: string } & ImportOptions;

/**
 * Состояние синхронизации с T-Invest API. `configured` — настроен ли токен на
 * бэке (сам токен наружу не выходит никогда, CLAUDE.md §8). `lastOperationDate` —
 * дата последней операции в журнале: с неё по умолчанию начинается период
 * синхронизации, чтобы не тянуть повторно уже импортированное из файла.
 */
const TbankStatusSchema = z.object({
  configured: z.boolean(),
  lastOperationDate: z.string().nullable(),
});
export type TbankStatus = z.infer<typeof TbankStatusSchema>;

const TbankAccountSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  type: z.string().optional(),
});
export type TbankAccount = z.infer<typeof TbankAccountSchema>;

@Injectable({ providedIn: 'root' })
export class ImportApi {
  private readonly http = inject(HttpClient);

  /** Доступна ли синхронизация с брокером (и с какой даты её начинать) */
  readonly tbankStatus = httpResource(() => '/api/import/tbank/status', {
    parse: TbankStatusSchema.parse,
  });

  /**
   * Счета клиента у брокера. Запрашиваются только когда токен настроен —
   * иначе запрос заведомо вернул бы 503 и зря показал бы пользователю ошибку.
   */
  readonly tbankAccounts = httpResource(
    () => (this.tbankStatus.value()?.configured ? '/api/import/tbank/accounts' : undefined),
    { parse: z.array(TbankAccountSchema).parse },
  );

  /**
   * Тянет операции у брокера за период. В базу ничего не пишет: возвращает
   * `uploadId`, с которым дальше вызываются обычные preview()/commit() — то есть
   * данные из API проходят ровно тот же путь проверки, что и файл.
   */
  tbankFetch(req: { accountId: string; from: string; to: string }): Promise<{
    uploadId: string;
    rows: number;
  }> {
    return firstValueFrom(
      this.http.post<{ uploadId: string; rows: number }>('/api/import/tbank/fetch', req),
    );
  }

  preview(req: ImportRequest): Promise<PreviewResult> {
    return firstValueFrom(this.http.post<PreviewResult>('/api/import/preview', req));
  }

  commit(req: ImportRequest): Promise<{ batchId: string; imported: number; updated: number }> {
    return firstValueFrom(
      this.http.post<{ batchId: string; imported: number; updated: number }>(
        '/api/import/commit',
        req,
        withToastSuccess('Импорт завершён'),
      ),
    );
  }

  rollback(batchId: string): Promise<{ deleted: number }> {
    return firstValueFrom(
      this.http.post<{ deleted: number }>(
        '/api/import/rollback',
        { batchId },
        withToastSuccess('Импорт отменён'),
      ),
    );
  }
}
