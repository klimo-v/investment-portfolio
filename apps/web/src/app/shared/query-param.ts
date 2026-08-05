import { computed, inject, type Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';

/** Чтение и запись query-параметров текущего роута */
export interface QueryParams {
  /** Значение параметра как сигнал; null — параметра в адресе нет */
  read(name: string): Signal<string | null>;
  /**
   * Записать НЕСКОЛЬКО параметров разом. Именно разом, а не по одному: см. коммент
   * к `queryParams()` — несколько navigate() подряд гасят друг друга.
   *
   * Возвращает промис навигации: вызывающему коду он обычно не нужен, а тестам —
   * нужен, иначе проверка читает адрес до того, как роутер его поменял.
   */
  patch(values: Record<string, string | null>): Promise<boolean>;
}

/**
 * Состояние фильтра, живущее в адресной строке, а не в приватном сигнале страницы:
 * срез переживает уход со страницы и F5, им можно поделиться ссылкой.
 *
 * ВАЖНО — почему `patch()` принимает СРАЗУ НЕСКОЛЬКО параметров, а не вызывается
 * по разу на каждый. Роутер выполняет навигацию асинхронно и отменяет текущую,
 * когда стартует следующая (NavigationCancel: SupersededByNewNavigation). При этом
 * `queryParamsHandling: 'merge'` считает базу от АКТУАЛЬНОГО адреса — а он ещё не
 * успел измениться. Поэтому три вызова подряд
 *
 *     periodParam.set('ytd'); fromParam.set(null); tillParam.set(null);
 *
 * давали не «period=ytd без дат», а «последний вызов победил, period потерян»:
 * период на дашборде переключался визуально, но в адрес не попадал, данные
 * оставались за всё время, а тумблер после пары переключений показывал одно, а
 * фильтр значил другое. Один вызов `patch()` = одна навигация = ничего не теряется.
 *
 * `replaceUrl: true` осознанно: смена фильтра не должна плодить записи в истории —
 * иначе «Назад» после пяти правок фильтра пять раз меняет фильтр вместо того, чтобы
 * увести со страницы.
 *
 * Пустое значение вычищает параметр из адреса, а не пишет `?system=` — иначе «Все»
 * выглядело бы в URL как выбранное значение.
 *
 * Вызывать в контексте инъекции — как `mediaQuery()` из web-shared.
 */
export function queryParams(): QueryParams {
  const route = inject(ActivatedRoute);
  const router = inject(Router);

  // Одна подписка на всю карту параметров; отдельные значения — computed поверх неё
  const paramMap = toSignal(route.queryParamMap, {
    initialValue: route.snapshot.queryParamMap,
  });

  return {
    read: (name) => computed(() => paramMap().get(name)),
    patch: (values) => {
      const queryParams: Record<string, string | null> = {};
      for (const [name, value] of Object.entries(values)) {
        // Пустая строка — это «параметра нет», а не «параметр равен пустоте»
        queryParams[name] = value || null;
      }
      return router.navigate([], {
        relativeTo: route,
        queryParams,
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
