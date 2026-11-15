import { TestBed } from '@angular/core/testing';
import { signal, computed } from '@angular/core';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { HttpTestingController } from '@angular/common/http/testing';
import { BehaviorSubject } from 'rxjs';
import { describe, it, expect } from 'vitest';
import { PortfolioCalendar } from '../../shared/portfolio-calendar';
import { dashboardFilter, rangeError } from './dashboard-filter.state';
import { summaryResource } from '../../entities/summary/summary.api';
import { performanceResource } from '../../entities/performance/performance.api';
import { valuationResource } from '../../entities/valuation/valuation.api';

describe('фильтр URL приостанавливает все расчёты', () => {
  it('ошибка, незавершённый ввод, исправление, один день и ограничение будущего till', () => {
    const params = new BehaviorSubject(
      convertToParamMap({ period: 'custom', from: '2026-02-31', till: '2026-03-05' }),
    );
    TestBed.configureTestingModule({
      providers: [
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
    const f = TestBed.runInInjectionContext(dashboardFilter);
    TestBed.runInInjectionContext(() => {
      const range = computed(() => (f.ready() ? f.range() : null));
      summaryResource(range);
      valuationResource(
        computed(() => (f.ready() ? { ...f.range(), groupBy: 'instrument' as const } : null)),
      );
      performanceResource(
        computed(() => (f.ready() ? { ...f.range(), scope: 'all' as const } : null)),
      );
    });
    const http = TestBed.inject(HttpTestingController);
    for (const q of [
      { from: '2026-02-31', till: '2026-03-05' },
      { from: '2026-02-29', till: '2026-03-05' },
      { from: '2026-03-06', till: '2026-03-05' },
      { from: '2026-03-01', till: '' },
      { from: '2030-01-01', till: '2030-01-31' },
    ]) {
      params.next(convertToParamMap({ period: 'custom', ...q }));
      TestBed.tick();
      expect(f.ready()).toBe(false);
      http.expectNone((r) => r.url.startsWith('/api/'));
    }
    params.next(convertToParamMap({ period: 'custom', from: '2024-02-29', till: '2024-02-29' }));
    TestBed.tick();
    expect(f.ready()).toBe(true);
    const requests = http.match((r) => r.url.startsWith('/api/'));
    expect(requests).toHaveLength(3);
    for (const r of requests) {
      expect(r.request.url).toContain('from=2024-02-29&till=2024-02-29');
      r.error(new ProgressEvent('test'));
    }
    params.next(convertToParamMap({ period: 'custom', from: '2026-01-01', till: '2030-01-01' }));
    TestBed.tick();
    expect(f.range()).toEqual({ from: '2026-01-01', till: '2026-11-15' });
    http.match(() => true).forEach((r) => r.error(new ProgressEvent('test')));
    for (const period of ['ytd', '1y', 'all']) {
      params.next(convertToParamMap({ period, portfolio: 'p1' }));
      expect(f.linkParams()).toEqual({ period, portfolio: 'p1' });
    }
    expect(rangeError('2026-03-06', '2026-03-05')).toContain('позже');
  });
});
