import { Injectable, computed, signal } from '@angular/core';

/**
 * Глобальный индикатор «идёт HTTP-запрос» (CLAUDE.md: обратная связь на каждый
 * запрос). Счётчик, а не флаг — запросы бывают параллельными (напр. массовое
 * удаление операций через Promise.all), флаг сбросился бы раньше времени.
 */
@Injectable({ providedIn: 'root' })
export class LoadingService {
  private readonly activeRequests = signal(0);

  readonly isLoading = computed(() => this.activeRequests() > 0);

  start(): void {
    this.activeRequests.update((n) => n + 1);
  }

  stop(): void {
    this.activeRequests.update((n) => Math.max(0, n - 1));
  }
}
