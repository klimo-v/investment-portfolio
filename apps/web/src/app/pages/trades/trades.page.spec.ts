import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { signal } from '@angular/core';
import { describe, it, expect, vi } from 'vitest';
import type { Trade } from '@core';
import { TradeApi } from '../../entities/trade/trade.api';
import { ReferenceApi } from '../../entities/reference/reference.api';
import { TradesPage } from './trades.page';

const row = (over: Partial<Trade>) =>
  ({
    ticker: 'SAME',
    instrumentId: 'X',
    systemId: 's1',
    portfolioId: 'p1',
    status: 'Closed',
    closedAt: '2026-01-02',
    realizedPnlRub: '-10',
    dividendsRub: '20',
    ...over,
  }) as Trade;
const resource = (value: unknown) => ({ hasValue: () => true, value: () => value });

describe('Контекст и срез страницы сделок', () => {
  async function setup(initial: Record<string, string> = {}) {
    const params = new BehaviorSubject(convertToParamMap(initial));
    const data = signal([
      row({}),
      row({ systemId: 's2', portfolioId: 'p2', closedAt: '2026-01-03' }),
      row({ status: 'Open', closedAt: null }),
    ]);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { queryParamMap: params, snapshot: { queryParamMap: params.value } },
        },
        { provide: TradeApi, useValue: { trades: { hasValue: () => true, value: data } } },
        {
          provide: ReferenceApi,
          useValue: { portfolios: resource([]), systems: resource([]), instruments: resource([]) },
        },
      ],
    });
    TestBed.overrideComponent(TradesPage, {
      set: {
        template: `<p id="counts">{{ openTrades().length }} / {{ closedTrades().length }}</p><p id="date">{{ dateError() }}</p><p id="stat">{{ statInputs()[0]?.realizedPnlRub }}</p><p id="tab">{{ tabIndex() }}</p><p id="empty">{{ filteredStatsEmpty() }}</p><button (click)="reset()">Сбросить</button>`,
      },
    });
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(TradesPage);
    fixture.detectChanges();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const text = (selector: string) => fixture.nativeElement.querySelector(selector).textContent;
    const patch = (values: Record<string, string>) => {
      params.next(convertToParamMap(values));
      fixture.detectChanges();
    };
    return { fixture, patch, text, navigate, data };
  }
  it('портфель/система/поиск действуют на оба списка; период закрытия включителен и не ограничивает открытые', async () => {
    const h = await setup({
      portfolio: 'p1',
      system: 's1',
      q: 'same',
      closedFrom: '2026-01-02',
      closedTill: '2026-01-02',
      tab: 'stats',
    });
    expect(h.text('#counts')).toBe('1 / 1');
    expect(h.text('#tab')).toBe('2');
    expect(h.text('#stat')).toBe('-10');
    h.patch({ system: 's2' });
    expect(h.text('#counts')).toBe('0 / 1');
    h.patch({ q: 'nothing' });
    expect(h.text('#counts')).toBe('0 / 0');
  });
  it('пустая статистика отличает отфильтрованные закрытые сделки от их отсутствия', async () => {
    const h = await setup({ q: 'nothing', tab: 'stats' });
    expect(h.text('#empty')).toBe('true');
    h.data.set([row({ status: 'Open', closedAt: null })]);
    h.fixture.detectChanges();
    expect(h.text('#empty')).toBe('false');
  });
  it('несуществующий день и обратные границы не применяются к закрытым; сброс очищает весь срез', async () => {
    const h = await setup({ closedFrom: '2026-02-31' });
    expect(h.text('#date')).toContain('несуществующая');
    expect(h.text('#counts')).toBe('1 / 0');
    h.patch({ closedFrom: '2026-02-02', closedTill: '2026-01-01' });
    expect(h.text('#date')).toContain('не позже');
    h.fixture.nativeElement.querySelector('button').click();
    expect(h.navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        queryParams: { portfolio: null, system: null, q: null, closedFrom: null, closedTill: null },
      }),
    );
  });
});
