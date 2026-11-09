import { describe, expect, it } from 'vitest';
import { journalCurrencyBalances, reconcileCurrencyBalances } from './currency-reconcile';
import type { Operation } from './schemas';

const op = (id: string, type: 'Buy' | 'Sell', qty: string, date: string): Operation => ({
  id, date, systemId: 's', portfolioId: 'p', instrumentId: 'CNY', operationType: type, quantity: qty, price: '12', fee: '0', fxRate: '1', currency: 'RUB',
});

describe('сверка валютных остатков с брокером', () => {
  const tickerOf = (id: string) => (id === 'CNY' ? 'CNYRUB_TOM' : 'SBER');

  it('журнал: количество валюты — позиция её пары (CNYRUB_TOM → CNY), прочие бумаги не считаются', () => {
    const ops = [op('1', 'Buy', '4226', '2024-08-01'), op('2', 'Buy', '15634', '2024-08-01'), op('3', 'Sell', '19860', '2024-09-04')];
    expect(journalCurrencyBalances(ops, tickerOf)).toEqual([{ currency: 'CNY', amount: '0' }]);
  });

  it('кейс 04.09.2024: журнал 19 860,18, у брокера 0,18 — расхождение называет валюту', () => {
    const r = reconcileCurrencyBalances([{ currency: 'cny', amount: '0.18' }], [{ currency: 'CNY', amount: '19860.18' }]);
    expect(r).toEqual([{ currency: 'CNY', broker: '0.18', journal: '19860.18', diff: '19860' }]);
  });

  it('после исправления (журнал 0,18, брокер 0,18) расхождений нет; хвост в пределах допуска не считается', () => {
    expect(reconcileCurrencyBalances([{ currency: 'cny', amount: '0.18' }], [{ currency: 'CNY', amount: '0.18' }])).toEqual([]);
    expect(reconcileCurrencyBalances([{ currency: 'cny', amount: '0.18' }], [{ currency: 'CNY', amount: '0' }])).toEqual([]);
  });

  it('валюта есть только у брокера или только в журнале; RUB не сверяется', () => {
    const r = reconcileCurrencyBalances(
      [{ currency: 'usd', amount: '500' }, { currency: 'rub', amount: '1530.76' }],
      [{ currency: 'CNY', amount: '100' }],
    );
    expect(r.map((m) => [m.currency, m.diff])).toEqual([['CNY', '100'], ['USD', '-500']]);
  });
});
