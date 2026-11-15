import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { HttpTestingController } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './dashboard.page';
import { PortfolioCalendar } from '../../shared/portfolio-calendar';

afterEach(() => vi.useRealTimers());

describe('«Считать с этой даты»: конец показанного расчёта', () => {
  it('в режиме «Всё время» сохраняет 15 ноября сервера, когда у браузера ещё 14-е', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 14, 13, 30));
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PortfolioCalendar,
          useValue: {
            today: signal('2026-11-15'),
            context: { error: signal(undefined), isLoading: signal(false), reload: () => true },
          },
        },
      ],
    });
    TestBed.overrideComponent(DashboardPage, {
      set: {
        template: `
      <button [disabled]="!performanceData()" (click)="applySuggestedStart('2026-11-13')">Считать с 13.11.2026</button>
    `,
      },
    });
    await TestBed.compileComponents();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(DashboardPage);
    fixture.detectChanges();
    TestBed.tick();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/performance?scope=all').flush({
      scope: 'all',
      id: null,
      from: null,
      till: '2026-11-15',
      total: {
        contour: 'wealth',
        from: null,
        till: '2026-11-15',
        baseDate: null,
        days: 3,
        startValueRub: '0',
        endValueRub: '1000',
        netFlowRub: '1000',
        resultRub: '0',
        breakdown: { fixedRub: '0', payoutsRub: '0', realizedRub: '0', revaluationRub: '0' },
        twr: { pct: null, series: [], reason: 'no-capital' },
        mwr: { kind: 'period', pct: null, reason: 'no-capital' },
        xirrPct: null,
        dietzPct: null,
        maxDrawdownPct: null,
        averageCapitalRub: '1000',
        twrSuggestedFrom: '2026-11-13',
      },
      bySystem: [],
      byPortfolio: [],
      byInstrument: [],
      warnings: [],
      carried: [],
    });
    await vi.waitFor(() => {
      TestBed.tick();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('button').disabled).toBe(false);
    });
    fixture.nativeElement.querySelector('button').click();
    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        queryParams: { period: 'custom', from: '2026-11-13', till: '2026-11-15' },
      }),
    );
    http.match(() => true).forEach((r) => r.error(new ProgressEvent('test cleanup')));
  });
});
