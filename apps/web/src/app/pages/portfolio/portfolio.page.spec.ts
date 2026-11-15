import { MatDialog } from '@angular/material/dialog';
import { ReferenceApi } from '../../entities/reference/reference.api';
import { MergedIdentifiersDialog } from '../../widgets/merged-identifiers/merged-identifiers.dialog';
import { ErrorHandler } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PositionSchema } from '@core';
import { formatPrice } from '@web-shared';
import { OperationApi } from '../../entities/operation/operation.api';
import { PortfolioPage } from './portfolio.page';

const totals = {
  investedRub: 1000,
  currentValueRub: null,
  unvaluedPositionCount: 1,
  realizedPnlRub: 0,
  unrealizedPnlRub: null,
  dividendsRub: 0,
  pnlRub: null,
  dividendYieldPct: 0,
};
const summary = {
  totals,
  cash: { cashRub: 500, totalValueRub: 500 },
  timeline: [],
  bySystem: [],
  byPortfolio: [],
  breakdown: [],
};
const position = PositionSchema.parse({
  instrumentId: 'test',
  ticker: 'TEST-USD',
  systemId: 's',
  portfolioId: 'p',
  type: 'Bond',
  currency: 'RUB',
  quantity: '1',
  avgBuyPrice: '1000',
  investedCcy: '1000',
  investedRub: '1000',
  realizedPnlRub: '0',
  dividendsRub: '0',
  couponsRub: '0',
  avgPriceCurrency: 'RUB',
  currentPrice: '10',
  priceCurrency: 'USD',
  accruedInterestRub: null,
  currentValueRub: null,
  pnlRub: null,
  valuationIssue: 'Нет курса USD',
});

describe('Портфель: независимые HTTP-ресурсы', () => {
  let fixture: ComponentFixture<PortfolioPage>;
  let http: HttpTestingController;
  let errors: unknown[];
  async function settle() {
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      TestBed.tick();
    }
    fixture.detectChanges();
  }
  const text = () => (fixture.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ') ?? '';
  const clickRetry = (title: string) => {
    const host = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('app-state-message'),
    ].find((e) => e.textContent?.includes(title));
    const button = host?.querySelector('button');
    expect(button).toBeTruthy();
    button?.click();
    fixture.detectChanges();
    TestBed.tick();
  };
  beforeEach(async () => {
    TestBed.resetTestingModule();
    errors = [];
    // jsdom не реализует IntersectionObserver; диаграмма в @defer остаётся за экраном.
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {
          return;
        }
        unobserve() {
          return;
        }
        disconnect() {
          return;
        }
      },
    );
    TestBed.configureTestingModule({
      providers: [
        { provide: ErrorHandler, useValue: { handleError: (e: unknown) => errors.push(e) } },
      ],
    });
    vi.spyOn(TestBed.inject(OperationApi), 'refreshQuotes').mockResolvedValue({
      updated: 0,
      total: 0,
      skippedManual: 0,
      failures: [],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PortfolioPage);
    fixture.detectChanges();
    TestBed.tick();
    await settle();
  });
  afterEach(() => {
    try {
      expect(errors).toEqual([]);
      http.verify();
    } finally {
      fixture?.destroy();
      TestBed.resetTestingModule();
      vi.unstubAllGlobals();
    }
  });
  async function initial(summaryFails: boolean, positionsFail: boolean) {
    for (const req of http.match(() => true)) {
      if (req.request.url.startsWith('/api/operations/summary')) {
        if (summaryFails) req.flush({}, { status: 500, statusText: 'Test' });
        else req.flush(summary);
      } else if (req.request.url === '/api/operations/positions') {
        if (positionsFail) req.flush({}, { status: 500, statusText: 'Test' });
        else req.flush([position]);
      } else req.flush([]);
    }
    fixture.detectChanges();
    TestBed.tick();
    await settle();
    fixture.detectChanges();
    TestBed.tick();
  }
  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])(
    'сводка 500=%s, позиции 500=%s; собственные повторы восстанавливают страницу',
    async (summaryFails, positionsFail) => {
      await initial(summaryFails, positionsFail);
      expect(text().includes('Не удалось загрузить сводку')).toBe(summaryFails);
      expect(text().includes('Не удалось загрузить позиции')).toBe(positionsFail);
      if (!positionsFail) expect(text()).toContain('TEST-USD');
      if (!summaryFails) expect(text()).toContain('Вложено (₽)');
      if (summaryFails) {
        clickRetry('Не удалось загрузить сводку');
        http.expectNone('/api/operations/positions');
        http.expectOne('/api/operations/summary').flush(summary);
        fixture.detectChanges();
        TestBed.tick();
        await settle();
      }
      if (positionsFail) {
        clickRetry('Не удалось загрузить позиции');
        http.expectNone('/api/operations/summary');
        http.expectOne('/api/operations/positions').flush([position]);
        fixture.detectChanges();
        TestBed.tick();
        await settle();
      }
      fixture.detectChanges();
      TestBed.tick();
      expect(text()).toContain('TEST-USD');
      expect(text()).toContain('Нет курса USD');
      expect(text()).toContain('Оценка недоступна · без оценки: 1');
      expect(text()).not.toContain('Не удалось загрузить');
      expect(
        (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
          'button[mattooltip^="Выгрузить"]',
        )?.disabled,
      ).toBe(false);
    },
  );
  it('частичная сумма группы и карточек не включает неизвестную позицию; после оценки предупреждение исчезает', async () => {
    const valued = {
      ...position,
      instrumentId: 'rub',
      ticker: 'TEST-RUB',
      currentPrice: '200',
      priceCurrency: 'RUB',
      currentValueRub: '200.00',
      pnlRub: '100.00',
      valuationIssue: null,
    };
    const partial = { ...summary, totals: { ...totals, investedRub: 1100, currentValueRub: 200 } };
    for (const req of http.match(() => true))
      req.flush(
        req.request.url.includes('/summary')
          ? partial
          : req.request.url.endsWith('/positions')
            ? [position, valued]
            : [],
      );
    await settle();
    expect(text()).toContain('200,00 ₽ по оценённым позициям · без оценки: 1');
    expect(text()).toContain('Нет курса USD');
    fixture.componentInstance['positionApi'].positions.reload();
    fixture.componentInstance['summary'].reload();
    await settle();
    http
      .expectOne('/api/operations/positions')
      .flush([
        { ...position, currentValueRub: '900.00', pnlRub: '-100.00', valuationIssue: null },
        valued,
      ]);
    http.expectOne('/api/operations/summary').flush({
      ...summary,
      totals: {
        ...totals,
        investedRub: 1100,
        currentValueRub: 1100,
        unvaluedPositionCount: 0,
        pnlRub: 0,
        unrealizedPnlRub: 0,
      },
    });
    await settle();
    expect(text()).not.toContain('без оценки');
    expect(text()).not.toContain('Нет курса USD');
    expect(text()).toContain('1 100,00 ₽');
  });
  it('загрузка отличается от успешного пустого ответа', async () => {
    expect(text()).toContain('Загрузка сводки');
    expect(text()).toContain('Загрузка позиций');
    for (const req of http.match(() => true))
      req.flush(
        req.request.url.includes('/summary')
          ? {
              ...summary,
              totals: {
                ...totals,
                investedRub: 0,
                currentValueRub: 0,
                unvaluedPositionCount: 0,
                pnlRub: 0,
                unrealizedPnlRub: 0,
              },
            }
          : [],
      );
    fixture.detectChanges();
    TestBed.tick();
    await settle();
    fixture.detectChanges();
    TestBed.tick();
    expect(text()).toContain('Позиций пока нет');
    expect(text()).not.toContain('Загрузка');
  });
  it('различает одинаковые тикеры без объединения строк; сброс пустого сочетания возвращает строки и сводку', async () => {
    const second = { ...position, systemId: 's2', portfolioId: 'p2' };
    for (const req of http.match(() => true)) {
      const url = req.request.url;
      req.flush(
        url.includes('/summary')
          ? summary
          : url.endsWith('/positions')
            ? [position, second]
            : url === '/api/systems'
              ? [
                  { id: 's', name: 'ЮВ1-2вх' },
                  { id: 's2', name: 'Другая система' },
                ]
              : url === '/api/portfolios'
                ? [
                    { id: 'p', name: 'Другой счёт' },
                    { id: 'p2', name: 'ТБанк' },
                  ]
                : [],
      );
    }
    await settle();
    const page = fixture.componentInstance;
    expect(page['groups']()[0].rows).toHaveLength(2);
    expect(text()).toContain('ЮВ1-2вх · Другой счёт');
    expect(text()).toContain('Другая система · ТБанк');
    page['systemFilter'].set('s');
    page['portfolioFilter'].set('p2');
    await settle();
    http
      .expectOne('/api/operations/summary?systemId=s&portfolioId=p2')
      .flush({ ...summary, totals: { ...totals, investedRub: 0 } });
    await settle();
    expect(text()).toContain('Нет позиций под выбранные фильтры');
    expect(text()).not.toContain('Позиций пока нет');
    const reset = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Сбросить фильтры'),
    );
    reset?.click();
    await settle();
    expect(page['systemFilter']()).toBeNull();
    expect(page['portfolioFilter']()).toBeNull();
    http.expectOne('/api/operations/summary').flush(summary);
    await settle();
    expect(page['groups']()[0].rows).toHaveLength(2);
    expect(text()).not.toContain('Нет позиций под выбранные фильтры');
  });
  it.each([
    [2, 2, 'Котировки обновлены: 2 из 2'],
    [2, 1, 'Обновлено 1 из 2'],
    [2, 0, 'Не получено ни одной цены из 2'],
    [0, 0, 'Нет инструментов для автообновления'],
  ])('результат обновления total=%s updated=%s', async (total, updated, message) => {
    await initial(false, false);
    vi.mocked(TestBed.inject(OperationApi).refreshQuotes).mockResolvedValue({
      total,
      updated,
      skippedManual: 1,
      failures:
        total > updated
          ? [{ ticker: 'FAIL', source: 'moex', reason: 'Источник не вернул цену' }]
          : [],
    });
    await fixture.componentInstance['refresh']();
    await settle();
    expect(text()).toContain(message);
    if (total > updated) expect(text()).toContain('FAIL · moex — Источник не вернул цену');
  });
  it('ошибка обновления не показывает прежний успешный результат', async () => {
    await initial(false, false);
    vi.mocked(TestBed.inject(OperationApi).refreshQuotes).mockRejectedValue(new Error('offline'));
    await fixture.componentInstance['refresh']();
    await settle();
    expect(text()).toContain('Не удалось обновить котировки');
    expect(text()).not.toContain('Нет инструментов для автообновления');
    expect(text()).toContain('TEST-USD');
  });
  it('повтор сводки сохраняет текущие фильтры', async () => {
    await initial(false, false);
    fixture.componentInstance['systemFilter'].set('s');
    fixture.componentInstance['portfolioFilter'].set('p');
    fixture.detectChanges();
    TestBed.tick();
    const url = '/api/operations/summary?systemId=s&portfolioId=p';
    http.expectOne(url).flush({}, { status: 500, statusText: 'Test' });
    fixture.detectChanges();
    TestBed.tick();
    await settle();
    clickRetry('Не удалось загрузить сводку');
    http.expectOne(url).flush(summary);
    fixture.detectChanges();
    TestBed.tick();
    await settle();
    expect(text()).toContain('TEST-USD');
  });
  it('формат цены: 2–8 знаков, без потери малых цен', async () => {
    await initial(false, false);
    expect(formatPrice('2.134567')).toBe('2,134567 ₽');
    expect(formatPrice('0.00001234')).toBe('0,00001234 ₽');
    expect(formatPrice('100.000000')).toBe('100,00 ₽');
    expect(formatPrice('2.130000', 'USD')).toBe('2,13 $');
  });
  it('состав P&L принадлежит строке; точные цены и происхождение', async () => {
    for (const req of http.match(() => true)) {
      if (req.request.url.includes('/summary')) req.flush(summary);
      else if (req.request.url === '/api/operations/positions')
        req.flush([
          {
            ...position,
            avgBuyPrice: '2.134567',
            currentPrice: '0.00001234',
            priceSource: 'broker-report',
            quoteDate: '2026-01-01',
            realizedPnlRub: '100',
            unrealizedPnlRub: '-30',
            dividendsRub: '10',
            pnlRub: '80',
          },
          {
            ...position,
            portfolioId: 'p2',
            realizedPnlRub: '200',
            unrealizedPnlRub: null,
            pnlRub: null,
          },
        ]);
      else req.flush([]);
    }
    await settle();
    expect(text()).toContain('2,134567 ₽');
    expect(text()).toContain('0,00001234 $');
    expect(text()).toContain('Цена по отчёту за 2026-01-01');
    const details = [...(fixture.nativeElement as HTMLElement).querySelectorAll('details')];
    expect(details).toHaveLength(2);
    details[0].querySelector('summary')?.click();
    expect(details[0].open).toBe(true);
    expect(details[1].open).toBe(false);
    expect(details[0].textContent).toContain('-30,00 ₽');
    expect(details[1].textContent).toContain('200,00 ₽');
  });
  it.each([
    ['Future', '20', 'Нет активов для распределения'],
    ['Stock', null, 'Оценка активов недоступна'],
    ['Stock', '0', 'Нет положительной стоимости для распределения'],
  ])('причина пустого распределения %s/%s', async (type, value, expected) => {
    for (const req of http.match(() => true)) {
      if (req.request.url.includes('/summary')) req.flush(summary);
      else if (req.request.url === '/api/operations/positions')
        req.flush([{ ...position, type, currentValueRub: value }]);
      else req.flush([]);
    }
    await settle();
    // Причина вычисляется до отбрасывания строк из диаграммы.
    expect(Reflect.get(fixture.componentInstance, 'allocationEmptyTitle')()).toBe(expected);
    if (type === 'Future')
      expect(Reflect.get(fixture.componentInstance, 'allocation')()).toEqual([]);
  });

  it.each([
    ['/api/instruments/possible-duplicates', 'Не удалось загрузить возможные дубли'],
    ['/api/instruments/merged-identifiers', 'Не удалось загрузить привязанные коды'],
  ])('ошибка %s локальна, повтор затрагивает только её ресурс', async (url, title) => {
    for (const req of http.match(() => true)) {
      if (req.request.url === url) req.flush({}, { status: 500, statusText: 'Test' });
      else
        req.flush(
          req.request.url.includes('/summary')
            ? summary
            : req.request.url.endsWith('/positions')
              ? [position]
              : [],
        );
    }
    await settle();
    expect(text()).toContain(title);
    expect(text()).toContain('TEST-USD');
    expect(text()).toContain('Вложено (₽)');
    clickRetry(title);
    const retries = http.match(() => true);
    expect(retries.map((r) => r.request.url)).toEqual([url]);
    retries[0].flush([]);
    await settle();
    expect(text()).not.toContain(title);
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('app-possible-duplicates')
        ?.textContent?.trim(),
    ).toBe('');
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('app-merged-identifiers')
        ?.textContent?.trim(),
    ).toBe('');
  });
  it('сбой обновления привязанных кодов в открытом диалоге не роняет страницу и повторяется локально', async () => {
    await initial(false, false);
    const reference = TestBed.inject(ReferenceApi);
    reference.mergedIdentifiers.set([
      {
        instrumentId: 'test',
        ticker: 'TEST',
        name: null,
        entries: [],
        conflicting: false,
        tickers: ['TEST'],
        merges: [],
      },
    ]);
    const dialog = TestBed.inject(MatDialog).open(MergedIdentifiersDialog);
    await settle();
    reference.mergedIdentifiers.reload();
    await settle();
    http
      .expectOne('/api/instruments/merged-identifiers')
      .flush({}, { status: 500, statusText: 'Test' });
    await settle();
    const host = document.querySelector('app-merged-identifiers-dialog');
    expect(host?.textContent).toContain('Не удалось загрузить привязанные коды');
    host?.querySelector<HTMLButtonElement>('app-state-message button')?.click();
    await settle();
    const requests = http.match(() => true);
    expect(requests.map((r) => r.request.url)).toEqual(['/api/instruments/merged-identifiers']);
    requests[0].flush([]);
    await settle();
    expect(host?.textContent).not.toContain('Не удалось загрузить');
    dialog.close();
    await settle();
  });
  it.each([
    ['manual', 'Stock', '10', '1', true],
    ['manual', 'Stock', null, '1', true],
    ['moex', 'Stock', null, '1', false],
    ['manual', 'Future', '10', '1', false],
    ['manual', 'Stock', '10', '0', false],
  ])(
    'видимость поиска %s/%s/%s/%s',
    async (marketSource, type, currentPrice, quantity, visible) => {
      for (const req of http.match(() => true))
        req.flush(
          req.request.url.includes('/summary')
            ? summary
            : req.request.url.endsWith('/positions')
              ? [{ ...position, marketSource, type, currentPrice, quantity }]
              : [],
        );
      await settle();
      expect(
        (fixture.nativeElement as HTMLElement).querySelectorAll(
          'button[aria-label="Найти цену на бирже"]',
        ).length,
      ).toBe(visible ? 1 : 0);
      expect(
        (fixture.nativeElement as HTMLElement).querySelectorAll(
          'button[aria-label="Объединить с другим инструментом"]',
        ).length,
      ).toBe(currentPrice === null && quantity !== '0' ? 1 : 0);
    },
  );
  it.each(['Bond', 'Stock'])(
    'частичная диаграмма считает позиции без оценки, в том числе одного типа %s',
    async (type) => {
      const rows = [
        { ...position, type: 'Stock', instrumentId: 'good', currentValueRub: '200' },
        { ...position, type, instrumentId: 'bad', currentPrice: null },
        { ...position, type: 'Future', instrumentId: 'future' },
        { ...position, instrumentId: 'closed', quantity: '0' },
      ].map((row) => PositionSchema.parse(row));
      for (const req of http.match(() => true))
        req.flush(
          req.request.url.includes('/summary')
            ? summary
            : req.request.url.endsWith('/positions')
              ? rows
              : [],
        );
      await settle();
      const page = fixture.componentInstance;
      expect(page['allocationUnvaluedCount']()).toBe(1);
      expect(page['allocation']().find((g) => g.label === 'Акции')?.valueRub).toBe(200);
      page['systemFilter'].set('no-positions');
      await settle();
      http.expectOne('/api/operations/summary?systemId=no-positions').flush(summary);
      await settle();
      expect(page['allocationUnvaluedCount']()).toBe(0);
      page['systemFilter'].set(null);
      await settle();
      http.expectOne('/api/operations/summary').flush(summary);
      await settle();
      page['positionApi'].positions.set(rows.map((r) => ({ ...r, currentValueRub: '200' })));
      await settle();
      expect(page['allocationUnvaluedCount']()).toBe(0);
    },
  );
});
