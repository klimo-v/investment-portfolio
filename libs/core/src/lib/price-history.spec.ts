import { describe, expect, it } from 'vitest';
import { fxInstrumentId, isFxInstrumentId, isMarketSource, PRICE_SOURCE_PRIORITY, shouldReplacePrice } from './price-history';

describe('политика источников цен', () => {
  it('порядок: рынок > отчёт брокера > котировка момента > снимок > ручная', () => {
    expect(PRICE_SOURCE_PRIORITY.moex).toBeGreaterThan(PRICE_SOURCE_PRIORITY['broker-report']);
    expect(PRICE_SOURCE_PRIORITY['broker-report']).toBeGreaterThan(PRICE_SOURCE_PRIORITY.quote);
    expect(PRICE_SOURCE_PRIORITY.quote).toBeGreaterThan(PRICE_SOURCE_PRIORITY.snapshot);
    expect(PRICE_SOURCE_PRIORITY.snapshot).toBeGreaterThan(PRICE_SOURCE_PRIORITY.manual);
  });
  it('слабый источник не заменяет сильный, равный — заменяет', () => {
    expect(shouldReplacePrice('moex', 'manual')).toBe(false);
    expect(shouldReplacePrice('broker-report', 'snapshot')).toBe(false);
    expect(shouldReplacePrice('manual', 'snapshot')).toBe(true);
    expect(shouldReplacePrice('moex', 'binance')).toBe(true);
  });
  it('официальное значение заменяет котировку момента, обратное — нет', () => {
    expect(shouldReplacePrice('quote', 'moex')).toBe(true);
    expect(shouldReplacePrice('quote', 'cbr')).toBe(true);
    expect(shouldReplacePrice('moex', 'quote')).toBe(false);
    expect(shouldReplacePrice('snapshot', 'quote')).toBe(true);
  });
  it('котировка момента не считается рыночным покрытием, снимок и ручная цена тоже', () => {
    expect(isMarketSource('quote')).toBe(false);
  });
  it('рыночными считаются биржа/ЦБ/Binance и отчёт брокера, но не снимок и не ручная цена', () => {
    expect(['moex', 'cbr', 'binance', 'broker-report'].every((s) => isMarketSource(s as 'moex'))).toBe(true);
    expect(isMarketSource('snapshot')).toBe(false);
    expect(isMarketSource('manual')).toBe(false);
  });
  it('курсы валют — синтетические id fx:XXX', () => {
    expect(fxInstrumentId('usd')).toBe('fx:USD');
    expect(isFxInstrumentId('fx:USD')).toBe(true);
    expect(isFxInstrumentId('SBER')).toBe(false);
  });
});
