import { TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { describe, it, expect, vi } from 'vitest';
import { MatPaginator } from '@angular/material/paginator';
import { By } from '@angular/platform-browser';
import { TradeSchema } from '@core';
import { TradesTable } from './trades-table';
import { OperationApi } from '../../entities/operation/operation.api';
import { ReferenceApi } from '../../entities/reference/reference.api';

const trade = TradeSchema.parse({
  id: 't',
  instrumentId: 'x',
  ticker: 'SAME',
  systemId: 's',
  portfolioId: 'p',
  type: 'Stock',
  currency: 'RUB',
  status: 'Closed',
  quantity: '0',
  qtyBought: '1',
  qtySold: '1',
  avgBuyPrice: '100',
  investedCcy: '0',
  investedRub: '0',
  purchasesRub: '102',
  proceedsCcy: '92',
  proceedsRub: '92',
  realizedPnlCcy: '-10',
  realizedPnlRub: '-10',
  dividendsRub: '20',
  couponsRub: '0',
  avgPriceCurrency: 'RUB',
  currentPrice: null,
  priceCurrency: null,
  currentValueRub: null,
  valuationIssue: null,
  pnlRub: '10',
  direction: 'Short',
  openedAt: '2026-01-01',
  closedAt: '2026-01-02',
  openedTime: null,
  closedTime: null,
  feesRub: '5',
  operationIds: ['op'],
});

@Component({
  imports: [TradesTable],
  template: `<app-trades-table [trades]="rows" [(pageSize)]="pageSize" /><app-trades-table
      [trades]="rows"
      [(pageSize)]="pageSize"
    />`,
})
class TablePair {
  readonly rows = Array.from({ length: 80 }, (_, i) => ({ ...trade, id: String(i) }));
  readonly pageSize = signal(25);
}

function render() {
  const loading = signal(false),
    error = signal<unknown>(null),
    loaded = signal(true),
    value = signal<unknown[]>([]);
  const read = vi.fn(() => {
    if (error()) throw Error('unsafe resource read');
    return value();
  });
  const reload = vi.fn(() => {
    error.set(null);
    loading.set(true);
    return true;
  });
  TestBed.configureTestingModule({
    providers: [
      {
        provide: OperationApi,
        useValue: {
          operations: {
            isLoading: loading,
            error,
            hasValue: () => loaded() && !error(),
            value: read,
            reload,
          },
        },
      },
      {
        provide: ReferenceApi,
        useValue: {
          systems: {
            hasValue: () => false,
            value: () => {
              throw Error('reference failure');
            },
          },
          portfolios: {
            hasValue: () => false,
            value: () => {
              throw Error('reference failure');
            },
          },
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(TradesTable);
  fixture.componentRef.setInput('trades', [trade]);
  fixture.detectChanges();
  const expand = () =>
    (fixture.nativeElement.querySelector('button[aria-expanded]') as HTMLButtonElement).click();
  return {
    fixture,
    loading,
    error,
    loaded,
    value,
    read,
    reload,
    expand,
    text: () => fixture.nativeElement.textContent as string,
  };
}

describe('Общая таблица сделок', () => {
  it('контекст, закрытый Short, состав полного результата и одно раскрытие кнопкой Material', () => {
    const h = render();
    expect(h.text()).toContain('s · p');
    expect(h.text()).toContain('Short');
    h.expand();
    h.fixture.detectChanges();
    expect(
      h.fixture.nativeElement.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(h.text()).toContain('Сумма покупок');
    expect(h.text()).toContain('102,00');
    expect(h.text()).toContain('-10,00');
    expect(h.text()).toContain('20,00');
    expect(h.text()).toContain('В журнале нет операций');
  });
  it('loading → HTTP500 → повтор только журнала → список; value не читается при ошибке', () => {
    const h = render();
    h.loading.set(true);
    h.expand();
    h.fixture.detectChanges();
    expect(h.text()).toContain('Загружаем журнал');
    h.loading.set(false);
    h.error.set(Error('500'));
    h.read.mockClear();
    h.fixture.detectChanges();
    expect(h.text()).toContain('Не удалось загрузить журнал');
    expect(h.read).not.toHaveBeenCalled();
    (Array.from(h.fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[])
      .find((b) => b.textContent?.includes('Повторить'))!
      .click();
    h.fixture.detectChanges();
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.loading.set(false);
    h.value.set([
      { id: 'op', date: '2026-01-01', operationType: 'Buy', quantity: '1', price: '100', fee: '0' },
    ]);
    h.fixture.detectChanges();
    expect(h.text()).toContain('Buy 1 @ 100');
  });
  it('неизвестный P&L содержит причину, известные суммы и ноль не исчезают', () => {
    const h = render();
    h.fixture.componentRef.setInput('trades', [
      {
        ...trade,
        status: 'Open',
        pnlRub: null,
        valuationIssue: 'Нет курса USD',
        dividendsRub: '0',
      },
    ]);
    h.fixture.detectChanges();
    expect(h.text()).toContain('Нет курса USD');
    expect(h.text()).toContain('0,00');
  });
  it('два списка связывают размер страницы, сохраняя отдельные номера и сортировки', () => {
    render(); // общие тестовые провайдеры журнала и справочника
    const fixture = TestBed.createComponent(TablePair);
    fixture.detectChanges();
    const paginators = fixture.debugElement
      .queryAll(By.directive(MatPaginator))
      .map((e) => e.componentInstance as MatPaginator);
    paginators[0].page.emit({ pageIndex: 1, pageSize: 50, length: 80 });
    fixture.detectChanges();
    expect(paginators.map((p) => p.pageSize)).toEqual([50, 50]);
    expect(paginators.map((p) => p.pageIndex)).toEqual([1, 0]);
    paginators[1].page.emit({ pageIndex: 1, pageSize: 50, length: 80 });
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.mat-sort-header-container') as HTMLElement).click();
    fixture.detectChanges();
    expect(paginators.map((p) => p.pageIndex)).toEqual([0, 1]);
  });
  it('сортировка сбрасывает страницу; выбранный размер сохраняется', () => {
    const h = render();
    h.fixture.componentRef.setInput(
      'trades',
      Array.from({ length: 80 }, (_, i) => ({ ...trade, id: String(i), ticker: 'X' + i })),
    );
    h.fixture.detectChanges();
    const paginator = h.fixture.debugElement.query(By.directive(MatPaginator))
      .componentInstance as MatPaginator;
    paginator.page.emit({ pageIndex: 1, pageSize: 50, length: 80 });
    h.fixture.detectChanges();
    expect(paginator.pageIndex).toBe(1);
    expect(paginator.pageSize).toBe(50);
    (h.fixture.nativeElement.querySelector('.mat-sort-header-container') as HTMLElement).click();
    h.fixture.detectChanges();
    expect(paginator.pageIndex).toBe(0);
    expect(paginator.pageSize).toBe(50);
  });
});
