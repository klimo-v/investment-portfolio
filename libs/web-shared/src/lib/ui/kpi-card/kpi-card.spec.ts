import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { KpiCard } from './kpi-card';

describe('KpiCard', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<KpiCard>>;

  beforeEach(() => {
    fixture = TestBed.createComponent(KpiCard);
    fixture.componentRef.setInput('label', 'Вложено');
    fixture.componentRef.setInput('value', '1 234,00 ₽');
  });

  it('рендерит подпись и значение', () => {
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;

    expect(el.textContent).toContain('Вложено');
    expect(el.textContent).toContain('1 234,00 ₽');
  });

  it('без hint бейдж «?» не рисуется — иначе на карточках без пояснения был бы мусор', () => {
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-hint')).toBeNull();
  });

  it('с hint появляется доступный бейдж app-hint (кнопка, а не span)', () => {
    fixture.componentRef.setInput('hint', 'Себестоимость держимого остатка');
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector('app-hint .badge');
    expect(badge).not.toBeNull();
    expect(badge.tagName).toBe('BUTTON');
    // Подпись карточки уходит в доступное имя — иначе скринридер зачитает
    // объяснение, не назвав, к чему оно относится
    expect(badge.getAttribute('aria-label')).toContain('Вложено');
  });

  it('tone превращается в глобальный класс pnl-*, который красит значение', () => {
    fixture.componentRef.setInput('tone', 'negative');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.pnl-negative')).not.toBeNull();
  });

  it('нейтральный tone маппится в существующий pnl-zero, а не в несуществующий pnl-neutral', () => {
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.pnl-zero')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.pnl-neutral')).toBeNull();
    expect(fixture.nativeElement.querySelector('.pnl-positive')).toBeNull();
    expect(fixture.nativeElement.querySelector('.pnl-negative')).toBeNull();
  });

  it('sub рендерится только когда задан', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.sub')).toBeNull();

    fixture.componentRef.setInput('sub', 'доходность +5,00%');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.sub')?.textContent).toContain('+5,00%');
  });
});
