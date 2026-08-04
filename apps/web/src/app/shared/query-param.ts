import { inject, type Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { ActivatedRoute, Router } from '@angular/router';

/** Query-параметр в виде сигнала: читать `value()`, писать `set()` */
export interface QueryParam {
  readonly value: Signal<string | null>;
  set(next: string | null): void;
}

/**
 * Состояние фильтра, живущее в адресной строке, а не в приватном сигнале страницы.
 *
 * Зачем: фильтры дашборда и журнала сбрасывались при любом уходе со страницы и при
 * F5, а ссылку «покажи мне вот этот срез» отправить было нельзя. URL — естественное
 * место для такого состояния: он переживает навигацию, копируется и восстанавливается
 * браузером сам.
 *
 * `replaceUrl: true` осознанно: смена фильтра не должна плодить записи в истории —
 * иначе «Назад» после пяти правок фильтра пять раз меняет фильтр вместо того, чтобы
 * увести со страницы.
 *
 * Пустое значение (null) вычищает параметр из URL, а не пишет `?system=` — иначе
 * «Все» выглядело бы в адресе как выбранное значение.
 *
 * Вызывать в контексте инъекции — как `mediaQuery()` из web-shared.
 */
export function queryParam(name: string): QueryParam {
  const route = inject(ActivatedRoute);
  const router = inject(Router);

  const value = toSignal(route.queryParamMap.pipe(map((params) => params.get(name))), {
    initialValue: route.snapshot.queryParamMap.get(name),
  });

  return {
    value,
    set(next: string | null): void {
      void router.navigate([], {
        relativeTo: route,
        queryParams: { [name]: next || null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    },
  };
}

/**
 * Значение из фиксированного набора: непонятное содержимое параметра (ручная правка
 * адреса, устаревшая ссылка) не должно ломать страницу — откатываемся к `fallback`.
 */
export function parseEnum<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}
