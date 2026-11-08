import { describe, expect, it } from 'vitest';
import type { Operation } from './schemas';
import { COMPLETENESS, journalCompleteness, warningTouchesPeriod, type CouponScheduleRow } from './journal-completeness';

const mk = (o: Partial<Operation> & Pick<Operation, 'date' | 'operationType'>): Operation =>
  ({ portfolioId: 'p1', systemId: 's1', quantity: '1', price: '0', fee: '0', fxRate: '1', currency: 'RUB', ...o }) as Operation;

const tickers = new Map([['OFZ', 'SU29015RMFS3']]);
const coupon = (couponDate: string, recordDate: string | null = null, amountRub: string | null = '40'): CouponScheduleRow => ({
  instrumentId: 'OFZ',
  couponDate,
  recordDate,
  amountRub,
});
const buy = mk({ date: '2026-01-05', operationType: 'Buy', instrumentId: 'OFZ', quantity: '100', price: '1000' });

describe('journalCompleteness: купоны по графику биржи', () => {
  it('бумага держалась на фиксацию, купона в журнале нет → предупреждение с ожидаемой суммой', () => {
    const w = journalCompleteness({ operations: [buy], schedules: [coupon('2026-04-22', '2026-04-21')], tickers, today: '2026-11-07' });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kind: 'missing-coupon', instrumentId: 'OFZ', ticker: 'SU29015RMFS3', date: '2026-04-22', amountRub: '4000.00' });
    expect(w[0].message).toContain('купон 2026-04-22');
  });

  it('купон есть — в окне вокруг даты выплаты (раньше на 3 дня и позже на 10) — предупреждения нет', () => {
    for (const date of ['2026-04-19', '2026-04-22', '2026-05-02']) {
      const ops = [buy, mk({ date, operationType: 'Coupon', instrumentId: 'OFZ', quantity: '1', price: '4000' })];
      expect(journalCompleteness({ operations: ops, schedules: [coupon('2026-04-22', '2026-04-21')], tickers, today: '2026-11-07' }), date).toEqual([]);
    }
  });

  it('купон за пределами окна не засчитывается', () => {
    const ops = [buy, mk({ date: '2026-05-03', operationType: 'Coupon', instrumentId: 'OFZ', quantity: '1', price: '4000' })];
    expect(journalCompleteness({ operations: ops, schedules: [coupon('2026-04-22', '2026-04-21')], tickers, today: '2026-11-07' })).toHaveLength(1);
  });

  it('не держали на фиксацию (купили за день до неё / продали раньше) — не проверяем', () => {
    const base = { schedules: [coupon('2026-04-22', '2026-04-21')], tickers, today: '2026-11-07' };
    const late = mk({ date: '2026-04-10', operationType: 'Buy', instrumentId: 'OFZ', quantity: '10', price: '1000' });
    expect(journalCompleteness({ operations: [late], ...base })).toHaveLength(1); // куплено 10.04 — держали на фиксацию, купона нет
    const veryLate = mk({ date: '2026-04-20', operationType: 'Buy', instrumentId: 'OFZ', quantity: '10', price: '1000' });
    expect(journalCompleteness({ operations: [veryLate], ...base })).toHaveLength(0); // за 1 день до фиксации — грейс
    const sold = mk({ date: '2026-03-01', operationType: 'Sell', instrumentId: 'OFZ', quantity: '100', price: '1000' });
    expect(journalCompleteness({ operations: [buy, sold], ...base })).toHaveLength(0);
  });

  it('срок ожидания ещё не вышел — рано судить; купон до первой сделки — не наш', () => {
    const ops = [buy];
    expect(journalCompleteness({ operations: ops, schedules: [coupon('2026-10-30', '2026-10-29')], tickers, today: '2026-11-07' })).toEqual([]);
    expect(journalCompleteness({ operations: ops, schedules: [coupon('2025-10-22', '2025-10-21')], tickers, today: '2026-11-07' })).toEqual([]);
    expect(COMPLETENESS.PAYOUT_WINDOW_DAYS).toBe(10);
  });

  it('другая бумага купон не закрывает; без суммы в графике — предупреждение без суммы', () => {
    const other = mk({ date: '2026-04-22', operationType: 'Coupon', instrumentId: 'OTHER', quantity: '1', price: '4000' });
    const w = journalCompleteness({ operations: [buy, other], schedules: [coupon('2026-04-22', '2026-04-21', null)], tickers, today: '2026-11-07' });
    expect(w).toHaveLength(1);
    expect(w[0].amountRub).toBeNull();
  });
});

describe('journalCompleteness: купон без привязки к бумаге и дата фиксации', () => {
  const base = { schedules: [coupon('2026-04-22', '2026-04-21')], tickers, today: '2026-11-07' };
  const loose = (date: string, id = 'L') =>
    mk({ id, date, operationType: 'Coupon', quantity: '1', price: '4000' } as Partial<Operation> & Pick<Operation, 'date' | 'operationType'>);

  it('Coupon без instrumentId в окне закрывает выплату — ложного «пропущен купон» нет', () => {
    expect(journalCompleteness({ operations: [buy, loose('2026-04-23')], ...base })).toEqual([]);
  });

  it('одна неатрибутированная операция закрывает ровно одну выплату, не все сразу', () => {
    const two: CouponScheduleRow[] = [coupon('2026-04-22', '2026-04-21'), { ...coupon('2026-04-22', '2026-04-21'), instrumentId: 'OFZ2' }];
    const buy2 = mk({ date: '2026-01-05', operationType: 'Buy', instrumentId: 'OFZ2', quantity: '10', price: '1000' });
    const w = journalCompleteness({ operations: [buy, buy2, loose('2026-04-22')], schedules: two, tickers, today: '2026-11-07' });
    expect(w).toHaveLength(1);
  });

  it('проданная накануне фиксации (расчёт T+1 до реестра) купон не получает — предупреждения нет', () => {
    const sold = mk({ date: '2026-04-20', operationType: 'Sell', instrumentId: 'OFZ', quantity: '100', price: '1000' });
    expect(journalCompleteness({ operations: [buy, sold], ...base })).toEqual([]); // реестр 21.04
  });

  it('нет даты фиксации: реестр считается за 3 дня до выплаты — продажа до него не даёт предупреждения, после — даёт', () => {
    const noRecord = { schedules: [coupon('2026-04-22', null)], tickers, today: '2026-11-07' }; // реестр ≈ 19.04
    const soldBefore = mk({ date: '2026-04-18', operationType: 'Sell', instrumentId: 'OFZ', quantity: '100', price: '1000' });
    const soldAfter = mk({ date: '2026-04-20', operationType: 'Sell', instrumentId: 'OFZ', quantity: '100', price: '1000' });
    expect(journalCompleteness({ operations: [buy, soldBefore], ...noRecord })).toEqual([]);
    expect(journalCompleteness({ operations: [buy, soldAfter], ...noRecord })).toHaveLength(1);
  });
});

describe('journalCompleteness: кэш ниже нуля', () => {
  const day = (i: number, v: string) => ({ date: `2026-03-${String(i).padStart(2, '0')}`, cashRub: v });

  it('одно предупреждение на весь отрицательный период: первый и последний день, худший остаток', () => {
    const cash = [day(1, '100.00'), day(2, '-400.00'), day(3, '-900.50'), day(4, '50.00'), day(5, '-300.00')];
    const w = journalCompleteness({ operations: [], schedules: [], cash, tickers, today: '2026-11-07' });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kind: 'negative-cash', date: '2026-03-02', dateTo: '2026-03-05', amountRub: '-900.50' });
    expect(w[0].message).toContain('4 дн.'.replace('4', '3'));
  });

  it('шум округления (меньше рубля) и отсутствие кэша у контура не дают предупреждения', () => {
    expect(journalCompleteness({ operations: [], schedules: [], cash: [day(1, '-0.40'), day(2, '0.00')], tickers, today: '2026-11-07' })).toEqual([]);
    expect(journalCompleteness({ operations: [], schedules: [], tickers, today: '2026-11-07' })).toEqual([]);
  });
});

describe('warningTouchesPeriod', () => {
  const w = { kind: 'negative-cash' as const, instrumentId: null, ticker: null, date: '2026-03-02', dateTo: '2026-03-05', amountRub: '-1', message: '' };
  it('пересечение периода с датами предупреждения', () => {
    expect(warningTouchesPeriod(w, '2026-03-04', '2026-12-31')).toBe(true);
    expect(warningTouchesPeriod(w, '2026-03-06', '2026-12-31')).toBe(false);
    expect(warningTouchesPeriod(w, undefined, '2026-03-01')).toBe(false);
    expect(warningTouchesPeriod(w, null, '2026-12-31')).toBe(true);
  });
});
