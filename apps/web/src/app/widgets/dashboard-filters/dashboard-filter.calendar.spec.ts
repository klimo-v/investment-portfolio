import { TestBed } from '@angular/core/testing';
import { computed } from '@angular/core';
import { HttpTestingController } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { describe, it, expect, vi } from 'vitest';
import { dashboardFilter } from './dashboard-filter.state';
import { summaryResource } from '../../entities/summary/summary.api';
import { performanceResource } from '../../entities/performance/performance.api';
import { valuationResource } from '../../entities/valuation/valuation.api';

describe('сбой календаря и повтор', () => {
  it('«Всё время»: ошибка health отличается от даты; повтор освобождает зависимые запросы', async () => {
    const params = new BehaviorSubject(convertToParamMap({ period: 'all' }));
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { queryParamMap: params, snapshot: { queryParamMap: params.value } },
        },
      ],
    });
    const filter = TestBed.runInInjectionContext(dashboardFilter);
    TestBed.runInInjectionContext(() => {
      summaryResource(computed(() => (filter.ready() ? {} : null)));
      performanceResource(computed(() => (filter.ready() ? { scope: 'all' as const } : null)));
      valuationResource(
        computed(() => (filter.ready() ? { groupBy: 'instrument' as const } : null)),
      );
    });
    const http = TestBed.inject(HttpTestingController);
    TestBed.tick();
    http.expectOne('/api/health').flush({}, { status: 500, statusText: 'Synthetic failure' });
    TestBed.tick();
    await vi.waitFor(() => {
      TestBed.tick();
      expect(filter.calendarError()).toBe(true);
    });
    expect(filter.calendarError()).toBe(true);
    expect(filter.error()).toBeNull();
    expect(filter.ready()).toBe(false);
    http.expectNone((r) => r.url !== '/api/health');
    filter.retryCalendar();
    TestBed.tick();
    http.expectOne('/api/health').flush({ today: '2026-11-15', timeZone: 'Europe/Moscow' });
    TestBed.tick();
    await vi.waitFor(() => {
      TestBed.tick();
      expect(filter.ready()).toBe(true);
    });
    expect(filter.calendarError()).toBe(false);
    expect(filter.ready()).toBe(true);
    const requests = http.match((r) => r.url !== '/api/health');
    expect(requests).toHaveLength(3);
    requests.forEach((r) => r.error(new ProgressEvent('test cleanup')));
    http.verify();
  });
});
