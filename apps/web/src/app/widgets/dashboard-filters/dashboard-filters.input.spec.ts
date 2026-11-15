import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { provideNativeDateAdapter } from '@angular/material/core';
import { BehaviorSubject } from 'rxjs';
import { describe, it, expect, vi } from 'vitest';
import { DashboardFilters } from './dashboard-filters';
import { dashboardFilter } from './dashboard-filter.state';
import { PortfolioCalendar } from '../../shared/portfolio-calendar';

describe('посимвольный ввод из пустого поля', () => {
  it('31.02.2026 даёт календарную ошибку даже когда Material всё время возвращает null', async () => {
    const params = new BehaviorSubject(convertToParamMap({ period: 'custom' }));
    TestBed.configureTestingModule({
      imports: [DashboardFilters],
      providers: [
        provideNativeDateAdapter(),
        {
          provide: ActivatedRoute,
          useValue: { queryParamMap: params, snapshot: { queryParamMap: params.value } },
        },
        {
          provide: PortfolioCalendar,
          useValue: {
            today: signal('2026-11-15'),
            context: { error: signal(undefined), isLoading: signal(false), reload: () => true },
          },
        },
      ],
    });
    vi.spyOn(TestBed.inject(Router), 'navigate').mockImplementation(async (_commands, options) => {
      const current = Object.fromEntries(params.value.keys.map((k) => [k, params.value.get(k)]));
      params.next(convertToParamMap({ ...current, ...options?.queryParams }));
      return true;
    });
    const fixture = TestBed.createComponent(DashboardFilters);
    fixture.detectChanges();
    TestBed.tick();
    const http = TestBed.inject(HttpTestingController);
    http.match(() => true).forEach((r) => r.flush([]));
    const filter = TestBed.runInInjectionContext(dashboardFilter);
    const input = fixture.nativeElement.querySelector('input[matStartDate]') as HTMLInputElement;
    const type = (text: string) => {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      TestBed.tick();
      for (const c of text) {
        input.value += c;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        TestBed.tick();
      }
      input.dispatchEvent(new Event('blur'));
      fixture.detectChanges();
    };
    type('31.02.2026');
    expect(filter.ready()).toBe(false);
    expect(filter.rawFrom()).toBe('31.02.2026');
    expect(fixture.nativeElement.textContent).toContain('несуществующая дата');
    http.expectNone((r) => /summary|valuation|performance/.test(r.url));
    type('29.02.2024');
    expect(filter.rawFrom()).toBe('2024-02-29');
    expect(filter.error()).toBeNull();
  });
});
