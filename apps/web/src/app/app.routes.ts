import { Route } from '@angular/router';

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
  {
    path: 'import',
    loadComponent: () => import('./pages/import/import.page').then((m) => m.ImportPage),
    title: 'Импорт',
  },
  { path: '**', redirectTo: 'dashboard' },
];
