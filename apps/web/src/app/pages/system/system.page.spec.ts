import { provideNativeDateAdapter } from '@angular/material/core';
import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { describe, expect, it, vi } from 'vitest';
import { systemPerformance } from '@core';
import { SystemPage } from './system.page';

describe('Страница системы', () => {
  it('исправление диапазона открывает денежный результат; повтор таблицы сохраняет период и KPI', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideNativeDateAdapter(),
        provideRouter(
          [{ path: 'systems/:systemId', component: SystemPage }],
          withComponentInputBinding(),
        ),
      ],
    });
    const harness = await RouterTestingHarness.create();
    const http = TestBed.inject(HttpTestingController);
    const path = '/systems/s?portfolio=p&period=custom&from=2026-06-01&till=';
    await harness.navigateByUrl(path, SystemPage);
    http.expectOne('/api/health').flush({ today: '2026-11-16', timeZone: 'Europe/Moscow' });
    http
      .match((r) => !r.url.includes('/trades') && !r.url.includes('/performance'))
      .forEach((r) => r.flush([]));
    TestBed.tick();
    const page = harness.routeNativeElement!;
    expect(page.querySelector('input[matEndDate]')).toBeTruthy();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.textContent).toContain('Укажите обе даты');
    });
    http.expectNone((r) => r.url.includes('/trades') || r.url.includes('/performance'));

    const till = '2026-06-30';
    const input = page.querySelector('input[matEndDate]') as HTMLInputElement;
    input.value = '30.06.2026';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toContain('till=2026-06-30'));
    TestBed.tick();
    const snapshot = '/api/operations/trades?systemId=s&portfolioId=p&from=2026-06-01&till=' + till;
    const body = systemPerformance([], {
      hasCashActivity: true,
      daily: [
        {
          date: till,
          investedRub: '0',
          marketValueRub: '0',
          fixedRub: '-7',
          unrealizedRub: '0',
          totalRub: '-7',
          standaloneCostsRub: '7',
          carried: [],
        },
      ],
    });
    http
      .expectOne('/api/systems/s/performance?portfolioId=p&from=2026-06-01&till=' + till)
      .flush({ ...body, systemId: 's', systemName: 'Система' });
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.textContent).toContain('Отдельные удержания');
    });
    http.expectOne(snapshot).flush({}, { status: 500, statusText: 'Test error' });
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.textContent).toContain('Не удалось загрузить сделки системы');
    });
    expect(page.textContent).toContain('Всего');
    const back = new URL((page.querySelector('a.back') as HTMLAnchorElement).href);
    expect(Object.fromEntries(back.searchParams)).toEqual({
      portfolio: 'p',
      period: 'custom',
      from: '2026-06-01',
      till,
    });
    (page.querySelector('.system-trades button') as HTMLButtonElement).click();
    TestBed.tick();
    http.expectOne(snapshot).flush([]);
    http.expectNone((r) => r.url.includes('/performance'));
    TestBed.tick();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.textContent).not.toContain('Не удалось загрузить сделки системы');
    });
  });
});
