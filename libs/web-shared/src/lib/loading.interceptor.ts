import { inject } from '@angular/core';
import type { HttpInterceptorFn } from '@angular/common/http';
import { finalize } from 'rxjs';
import { LoadingService } from './loading.service';

/**
 * Отмечает каждый HTTP-запрос (мутации и httpResource-GET) в LoadingService —
 * даёт глобальный индикатор загрузки без правок на каждой странице.
 */
export const loadingInterceptor: HttpInterceptorFn = (req, next) => {
  const loading = inject(LoadingService);
  loading.start();
  return next(req).pipe(finalize(() => loading.stop()));
};
