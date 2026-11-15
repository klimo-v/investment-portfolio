import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { EffectivenessSchema, PeriodPerformanceSchema } from '@core';
import { formatMoney, formatRub, formatValuation } from '@web-shared';
import { SummaryKpis } from './summary-kpis';
import { DataQuality } from '../data-quality/data-quality';
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
  it('20% помечены как приблизительные, дата стоимости и причина доступны', () => {
    const quality=[{instrumentId:'TEST',reason:'no-price' as const,priceDate:null,dates:['2026-01-01']}];
    const p={...performance,quality,twr:{...performance.twr,pct:20},mwr:{...performance.mwr,pct:20}};
    const f=TestBed.createComponent(SummaryKpis);
    f.componentRef.setInput('totals',{...totals,unvaluedPositionCount:0,currentValueRub:1200});
    f.componentRef.setInput('cash',{cashRub:0,totalValueRub:1200});
    f.componentRef.setInput('performance',p); f.componentRef.setInput('valuationDate','2026-01-04'); f.detectChanges();
    const cards=[...(f.nativeElement as HTMLElement).querySelectorAll('app-kpi-card')];
    expect(cards.find(c=>c.textContent?.includes('Доходность стратегии'))?.textContent).toContain('приблизительно');
    expect(cards.find(c=>c.textContent?.includes('Доходность стратегии'))?.textContent).toContain('+20.00%');
    expect(cards.find(c=>c.textContent?.includes('Позиции'))?.textContent).toContain('на 2026-01-04');
    const table=TestBed.createComponent(EffectivenessTable);
    table.componentRef.setInput('groupBy','system');
    table.componentRef.setInput('valuationDate','2026-01-04');
    table.componentRef.setInput('rows',[
      {...totals,id:'s1',name:'С проблемой',performance:p},
      {...totals,id:'s2',name:'Без проблемы',performance},
    ]); table.detectChanges();
    const rows=[...(table.nativeElement as HTMLElement).querySelectorAll('tr.mat-mdc-row')];
    expect(rows[0].textContent).toContain('приблизительно');
    expect(rows[1].textContent).not.toContain('приблизительно');
    const detail=TestBed.createComponent(DataQuality);
    detail.componentRef.setInput('carried',[{...quality[0],ticker:'TEST'}]); detail.detectChanges();
    expect((detail.nativeElement as HTMLElement).textContent).toContain('TEST · 2026-01-01: нет цены, оценено по себестоимости');
    f.destroy();table.destroy();detail.destroy();
  });

});
