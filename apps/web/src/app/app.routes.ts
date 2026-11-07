import { inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Route, Router, type CanActivateFn } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import type { StrategySummary } from '@core';

/**
 * Редирект с `/strategies` на первую стратегию. Запрос списка — одноразовый, на время
 * навигации, поэтому RxJS-оператор здесь уместен (не сигнал).
 */
const firstStrategyGuard: CanActivateFn = () => {
  const router = inject(Router);
  return inject(HttpClient)
    .get<StrategySummary[]>('/api/strategies')
    .pipe(
      map((list) => router.createUrlTree(list.length > 0 ? ['/strategies', list[0].systemId] : ['/dashboard'])),
      catchError(() => of(router.createUrlTree(['/dashboard']))),
    );
};

/**
 * Роуты — только ленивая загрузка фич (CLAUDE.md §2, §9).
 * Каждая страница грузится отдельным чанком → маленький начальный бандл.
 */
export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  {
    path: 'dashboard',
    loadComponent: () =>
      import('./pages/dashboard/dashboard.page').then((m) => m.DashboardPage),
    title: 'Дашборд',
  },
  {
    path: 'portfolio',
    loadComponent: () =>
      import('./pages/portfolio/portfolio.page').then((m) => m.PortfolioPage),
    title: 'Портфель',
  },
  {
    path: 'operations',
    loadComponent: () =>
      import('./pages/operations/operations.page').then((m) => m.OperationsPage),
    title: 'Операции',
  },
  {
    path: 'trades',
    loadComponent: () => import('./pages/trades/trades.page').then((m) => m.TradesPage),
    title: 'Сделки',
  },
  // /strategies без id — на первую настроенную стратегию (или на дашборд, если их нет)
  { path: 'strategies', pathMatch: 'full', canActivate: [firstStrategyGuard], children: [] },
  {
    path: 'strategies/:systemId',
    loadComponent: () => import('./pages/strategy/strategy.page').then((m) => m.StrategyPage),
    title: 'Стратегия',
  },
  // старая ссылка на страницу ЮВ1
  { path: 'yv1', redirectTo: 'strategies' },
  {
    path: 'import',
    loadComponent: () => import('./pages/import/import.page').then((m) => m.ImportPage),
    title: 'Импорт',
  },
  { path: '**', redirectTo: 'dashboard' },
];
