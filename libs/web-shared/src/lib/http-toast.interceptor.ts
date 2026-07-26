import { inject } from '@angular/core';
import {
  HttpContext,
  HttpContextToken,
  HttpEventType,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { catchError, tap, throwError } from 'rxjs';
import { ToastService } from './toast.service';
import { extractErrorMessage } from './extract-error-message';

/**
 * Опциональное человекочитаемое описание мутации — читает httpToastInterceptor,
 * чтобы показать тост об успехе. Без него запрос отрабатывает молча при успехе
 * (иначе на каждый фоновый httpResource-GET сыпались бы бессмысленные тосты).
 */
export const TOAST_MESSAGE = new HttpContextToken<string | undefined>(() => undefined);

/** Прокинуть сообщение об успехе в опции запроса: `http.post(url, body, withToastSuccess('...'))` */
export function withToastSuccess(message: string): { context: HttpContext } {
  return { context: new HttpContext().set(TOAST_MESSAGE, message) };
}

/**
 * Единая обратная связь по каждому HTTP-запросу (CLAUDE.md): успех мутации,
 * размеченной withToastSuccess, и любая ошибка сервера — тостом. Ошибка не
 * подменяет локальный try/catch вызывающего кода — прокидывается дальше.
 */
export const httpToastInterceptor: HttpInterceptorFn = (req, next) => {
  const toast = inject(ToastService);

  return next(req).pipe(
    tap((event) => {
      if (event.type !== HttpEventType.Response) return;
      const message = req.context.get(TOAST_MESSAGE);
      if (message) toast.success(message);
    }),
    catchError((err: unknown) => {
      toast.error(extractErrorMessage(err, 'Не удалось выполнить запрос.'));
      return throwError(() => err);
    }),
  );
};
