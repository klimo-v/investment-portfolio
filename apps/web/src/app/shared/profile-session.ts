import { DestroyRef, Injectable, inject } from '@angular/core';
import { HttpBackend, HttpClient, HttpInterceptorFn } from '@angular/common/http';
import { firstValueFrom, from, switchMap } from 'rxjs';

/** HTTP backend исключает рекурсию интерцептора при получении поколения. */
@Injectable({ providedIn: 'root' })
export class ProfileSession {
  private readonly http = new HttpClient(inject(HttpBackend));
  private generation?: string;
  private initial?: Promise<string>;
  constructor() {
    const refresh = (): void => {
      void this.check().catch(() => undefined);
    };
    const timer = window.setInterval(refresh, 3000);
    window.addEventListener('focus', refresh);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    });
  }
  ready(): Promise<string> {
    return (this.initial ??= this.check().catch((error: unknown) => {
      this.initial = undefined;
      throw error;
    }));
  }
  private async check(): Promise<string> {
    const status = await firstValueFrom(this.http.get<unknown>('/api/data/status'));
    if (
      !status ||
      typeof status !== 'object' ||
      !('generation' in status) ||
      typeof status.generation !== 'string'
    )
      throw new Error('Некорректный ответ состояния базы.');
    if (this.generation && status.generation !== this.generation) window.location.reload();
    this.generation = status.generation;
    return status.generation;
  }
}

export const profileSessionInterceptor: HttpInterceptorFn = (request, next) => {
  const session = inject(ProfileSession);
  if (!request.url.startsWith('/api/')) return next(request);
  return from(session.ready()).pipe(
    switchMap((generation) =>
      next(
        request.clone({
          setHeaders: { 'X-Portfolio-Generation': generation },
        }),
      ),
    ),
  );
};
