import {
  ApplicationConfig,
  provideZonelessChangeDetection,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import {
  provideHttpClient,
  withFetch,
  withInterceptors,
  withXsrfConfiguration,
} from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideNativeDateAdapter } from '@angular/material/core';
import { provideCharts, withDefaultRegisterables } from 'ng2-charts';
import { loadingInterceptor, httpToastInterceptor } from '@web-shared';
import { appRoutes } from './app.routes';

/**
 * Конфигурация приложения (CLAUDE.md §3, §4, §8):
 * - zoneless change detection (без Zone.js — реактивность на сигналах)
 * - роутинг с ленивой загрузкой фич
 * - HttpClient с fetch, XSRF-защитой и глобальными интерцепторами (индикатор
 *   загрузки + тосты успеха/ошибки для всех запросов, libs/web-shared)
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(appRoutes, withComponentInputBinding()),
    provideHttpClient(
      withFetch(),
      withXsrfConfiguration({ cookieName: 'XSRF-TOKEN', headerName: 'X-XSRF-TOKEN' }),
      withInterceptors([loadingInterceptor, httpToastInterceptor]),
    ),
    provideAnimationsAsync(),
    provideNativeDateAdapter(),
    provideCharts(withDefaultRegisterables()),
  ],
};
