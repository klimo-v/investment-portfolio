import { describe, expect, it } from 'vitest';
import { cyclesToDailyResults, type ClosableCycle } from './strategy-results';

const cycle = (o: Partial<ClosableCycle> & { net: string }): ClosableCycle => ({
  status: 'closed',
  closeDate: '2026-11-06',
  pnlPrice: o.net,
  costs: { total: '0' },
  debtInterest: '0',
  netRub: o.net,
  ...o,
});

describe('cyclesToDailyResults', () => {
  it('складывает закрытые циклы по дате закрытия, net = цена − издержки − проценты', () => {
    const r = cyclesToDailyResults([
      cycle({ pnlPrice: '1000.10', costs: { total: '14.78' }, debtInterest: '1.12', netRub: '984.20', net: '' }),
      cycle({ pnlPrice: '-200', costs: { total: '10' }, debtInterest: '0', netRub: '-210', net: '' }),
      cycle({ closeDate: '2026-11-09', pnlPrice: '50', costs: { total: '5' }, netRub: '45', net: '' }),
    ]);
    expect(r).toEqual([
      { date: '2026-11-06', pricePnlRub: '800.10', costsRub: '24.78', debtInterestRub: '1.12', netRub: '774.20', cycles: 2 },
      { date: '2026-11-09', pricePnlRub: '50.00', costsRub: '5.00', debtInterestRub: '0.00', netRub: '45.00', cycles: 1 },
    ]);
  });

  it('открытые и частично закрытые циклы в ленту не попадают', () => {
    expect(
      cyclesToDailyResults([
        cycle({ status: 'open', closeDate: null, net: '100' }),
        cycle({ status: 'partial', closeDate: null, net: '100' }),
        cycle({ status: 'closed', closeDate: null, net: '100' }),
      ]),
    ).toEqual([]);
  });

  it('копейки не плывут: 0.1 + 0.2 даёт ровно 0.30', () => {
    const r = cyclesToDailyResults([cycle({ net: '0.1' }), cycle({ net: '0.2' })]);
    expect(r[0].netRub).toBe('0.30');
  });
});
