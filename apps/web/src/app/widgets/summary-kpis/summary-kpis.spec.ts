import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { EffectivenessSchema, PeriodPerformanceSchema } from '@core';
import { formatMoney, formatRub, formatValuation } from '@web-shared';
import { SummaryKpis } from './summary-kpis';
import { EffectivenessTable } from '../effectiveness-table/effectiveness-table';

const performance = PeriodPerformanceSchema.parse({
  contour: 'wealth',
  from: null,
  till: null,
  baseDate: null,
  days: 1,
  startValueRub: '0',
  endValueRub: '100',
  netFlowRub: '0',
  resultRub: '100',
  breakdown: { fixedRub: '50', realizedRub: '30', payoutsRub: '20', revaluationRub: '50' },
  twr: { pct: null, series: [], reason: null },
  mwr: { kind: 'period', pct: null, reason: null },
  xirrPct: null,
  dietzPct: null,
  maxDrawdownPct: null,
  averageCapitalRub: '100',
});
const totals = EffectivenessSchema.parse({
  investedRub: 1000,
  currentValueRub: 200,
  unvaluedPositionCount: 1,
  realizedPnlRub: 30,
  unrealizedPnlRub: null,
  dividendsRub: 20,
  pnlRub: null,
  dividendYieldPct: 2,
});
afterEach(() => TestBed.resetTestingModule());

describe('Неполная оценка в карточках и разрезах', () => {
  it('null остаётся прочерком, ноль — известной суммой', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatRub(null)).toBe('—');
    expect(formatRub(undefined)).toBe('—');
    expect(formatRub(0)).toContain('0,00');
    expect(formatValuation(200, 1)).toContain('по оценённым позициям · без оценки: 1');
    expect(formatValuation(null, 1)).toBe('Оценка недоступна · без оценки: 1');
    expect(formatValuation(0, 0)).not.toContain('без оценки');
  });
  it('дашборд помечает позиции и сумму с деньгами; полный результат скрыт, журнал виден', () => {
    const f = TestBed.createComponent(SummaryKpis);
    f.componentRef.setInput('totals', totals);
    f.componentRef.setInput('cash', { cashRub: 500, totalValueRub: 700 });
    f.componentRef.setInput('performance', performance);
    f.detectChanges();
    const cards = [...(f.nativeElement as HTMLElement).querySelectorAll('app-kpi-card')];
    expect(cards.find((c) => c.textContent?.includes('Всего в портфеле'))?.textContent).toContain(
      'без оценки: 1',
    );
    expect(cards.find((c) => c.textContent?.includes('Позиции'))?.textContent).toContain(
      'по оценённым позициям',
    );
    const result = (f.nativeElement as HTMLElement).querySelector('.kpi-manual');
    expect(result?.querySelector('mat-card-title')?.textContent).toBe('—');
    expect(result?.textContent).toContain('30,00');
    expect(result?.textContent).toContain('20,00');
    f.componentRef.setInput('totals', {
      ...totals,
      unvaluedPositionCount: 0,
      pnlRub: 100,
      unrealizedPnlRub: 50,
    });
    f.detectChanges();
    expect(result?.querySelector('mat-card-title')?.textContent).toContain('100,00');
    expect((f.nativeElement as HTMLElement).textContent).not.toContain('без оценки');
    f.destroy();
  });
  it.each(['system', 'portfolio'])(
    'разрез %s помечает частичную оценку, полный результат скрыт',
    (groupBy) => {
      const f = TestBed.createComponent(EffectivenessTable);
      f.componentRef.setInput('groupBy', groupBy);
      f.componentRef.setInput('rows', [
        { ...totals, id: 's', name: 'Синтетический счёт', performance },
      ]);
      f.detectChanges();
      const row = (f.nativeElement as HTMLElement).querySelector('tr.mat-mdc-row');
      expect(row?.textContent).toContain('по оценённым позициям · без оценки: 1');
      expect(row?.querySelector('.mat-column-pnl')?.textContent?.trim()).toBe('—');
      f.destroy();
    },
  );
});
