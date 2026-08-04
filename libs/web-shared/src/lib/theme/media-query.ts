import { DestroyRef, inject, signal, type Signal } from '@angular/core';

/**
 * Медиазапрос как сигнал. Нужен там, где по CSS не обойтись: `MatDrawer.mode` —
 * это TS-вход, а `prefers-color-scheme` читает ThemeService.
 *
 * Почему не CDK `BreakpointObserver`: он отдаёт Observable, который всё равно
 * пришлось бы мостить через `toSignal`, а сырой matchMedia-сигнал нужен и для темы —
 * один примитив на два вызова лучше, чем примитив плюс RxJS-мост (CLAUDE.md §5:
 * RxJS оставляем для потоков событий, а не для одного булева флага).
 *
 * Вызывать только в контексте инъекции (инициализатор поля или конструктор):
 * отписка от `change` вешается на `DestroyRef`.
 */
export function mediaQuery(query: string): Signal<boolean> {
  // Нет matchMedia — среда без DOM (тесты в node, потенциальный SSR): считаем «не совпало»
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return signal(false).asReadonly();
  }

  const mql = window.matchMedia(query);
  const matches = signal(mql.matches);
  const onChange = (event: MediaQueryListEvent): void => matches.set(event.matches);

  mql.addEventListener('change', onChange);
  inject(DestroyRef).onDestroy(() => mql.removeEventListener('change', onChange));

  return matches.asReadonly();
}
