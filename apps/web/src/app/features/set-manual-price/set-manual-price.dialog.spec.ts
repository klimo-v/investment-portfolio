import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetManualPriceDialog } from './set-manual-price.dialog';

describe('Предзаполнение ручной цены', () => {
  afterEach(() => TestBed.resetTestingModule());
  it.each([
    ['USD', 'USD', '10'],
    ['RUB', 'USD', '10'],
    ['USD', 'RUB', '1000'],
    ['RUB', 'RUB', ''],
  ])('валюта средней %s, текущей %s → %s USD', (avgPriceCurrency, priceCurrency, expected) => {
    TestBed.configureTestingModule({providers: [
      {provide: MAT_DIALOG_DATA, useValue: {ticker: 'TEST', currency: 'USD', avgBuyPrice: '1000', currentPrice: '10', avgPriceCurrency, priceCurrency}},
      {provide: MatDialogRef, useValue: {close: vi.fn()}},
    ]});
    const fixture = TestBed.createComponent(SetManualPriceDialog);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('input')?.value).toBe(expected);
    const save = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(b => b.textContent?.includes('Сохранить'));
    expect(save?.disabled).toBe(expected === '');
    fixture.destroy();
  });
});
