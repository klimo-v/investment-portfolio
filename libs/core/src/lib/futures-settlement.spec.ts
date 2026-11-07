import { describe, expect, it } from 'vitest';
import { reconcileFuturesSettlement, type SettlementInput } from './futures-settlement';
import { CNY_FUTURE_ID, CNY_OPS, cnyOperation } from './futures-report.fixture';

/** Эталон отчёта SESPS 27.10–05.11.2026: ВМ 204,00 + плановая −11 117,00, расчётная 12 387 */
const REPORT: SettlementInput = {
  periodFrom: '2026-10-27',
  date: '2026-11-05',
  vmPeriod: '204.00',
  vmPlanned: '-11117.00',
  qtyStart: '0',
  markStart: null,
  markEnd: '12387',
};

describe('reconcileFuturesSettlement', () => {
  it('эталон: результат движка сходится с ВМ отчёта, расхождение 0', () => {
    const r = reconcileFuturesSettlement(CNY_OPS, CNY_FUTURE_ID, 'p1', REPORT);
    expect(r.status).toBe('ok');
    expect(r.brokerRub.toString()).toBe('-10913');
    expect(r.engineRub?.toFixed(2)).toBe('-10913.00');
    expect(r.diffRub?.abs().toNumber()).toBe(0);
  });

  it('пропущенная сделка — расхождение больше допуска, mismatch с суммой', () => {
    const lost = CNY_OPS.filter((o) => o.brokerRef !== '1008'); // потеряли покупку 81 @ 12 467
    const r = reconcileFuturesSettlement(lost, CNY_FUTURE_ID, 'p1', REPORT);
    expect(r.status).toBe('mismatch');
    expect(r.diffRub?.abs().gt(1)).toBe(true);
  });

  it('чужой портфель не участвует в сверке', () => {
    const r = reconcileFuturesSettlement(CNY_OPS, CNY_FUTURE_ID, 'other', REPORT);
    // в этом портфеле операций нет (движок = 0), а ВМ брокера −10 913 — это расхождение
    expect(r.status).toBe('mismatch');
    expect(r.engineRub?.toString()).toBe('0');
  });

  it('нет расчётной цены на конец при открытой позиции — unknown, а не ложный ok', () => {
    const r = reconcileFuturesSettlement(CNY_OPS, CNY_FUTURE_ID, 'p1', { ...REPORT, markEnd: null });
    expect(r.status).toBe('unknown');
    expect(r.reason).toContain('расчётной цены');
  });

  it('следующий отчёт: позиция перешла из прошлого периода и закрылась (знак ВМ важен)', () => {
    // 06.11 закрытие −128 @ 12 405; отчёт 06.11–06.11: позиция на начало −128 по расчётной 12 387
    const exit = cnyOperation(['2026-11-06', '10:20:00', 'Buy', '128', '12405', '0', '1015'], 14);
    // шорт 128 с расчётной 12 387 закрыт по 12 405: цена выросла на 18 ₽ × 128 = −2 304 ₽
    // для шорта, но ВМ брокера в этом тесте задана +2 304 — знак специально «неверный»,
    // чтобы проверить, что сверка ловит и расхождение знака
    const next: SettlementInput = {
      periodFrom: '2026-11-06',
      date: '2026-11-06',
      vmPeriod: '2304.00',
      vmPlanned: '0',
      qtyStart: '-128',
      markStart: '12387',
      markEnd: null,
    };
    const r = reconcileFuturesSettlement([...CNY_OPS, exit], CNY_FUTURE_ID, 'p1', next);
    expect(r.engineRub?.toFixed(2)).toBe('-2304.00');
    expect(r.brokerRub.toString()).toBe('2304');
    expect(r.status).toBe('mismatch');
    // с верным знаком ВМ (−2 304) сверка сходится
    const ok = reconcileFuturesSettlement([...CNY_OPS, exit], CNY_FUTURE_ID, 'p1', { ...next, vmPeriod: '-2304.00' });
    expect(ok.status).toBe('ok');
  });

  it('позиция в журнале не совпадает с отчётом на начало периода — unknown с пояснением', () => {
    const r = reconcileFuturesSettlement(CNY_OPS, CNY_FUTURE_ID, 'p1', {
      ...REPORT,
      periodFrom: '2026-11-05',
      qtyStart: '0', // в журнале на начало 05.11 открыт шорт −130
      markStart: '12000',
    });
    expect(r.status).toBe('unknown');
    expect(r.reason).toContain('не совпадает');
  });

  it('встречные позиции двух систем на начало периода нетто-сверяются с брокером', () => {
    // система s2 держит шорт 2, система s1 — лонг 3: у брокера на счёте нетто +1
    const mk = (id: string, systemId: string, side: 'Buy' | 'Sell', qty: string) => ({
      ...cnyOperation(['2026-10-01', '10:00:00', side, qty, '12000', '0', id], 0),
      id,
      systemId,
    });
    const ops = [mk('a', 's1', 'Buy', '3'), mk('b', 's2', 'Sell', '2')];
    const r = reconcileFuturesSettlement(ops, CNY_FUTURE_ID, 'p1', {
      periodFrom: '2026-11-01',
      date: '2026-11-02',
      vmPeriod: '0',
      vmPlanned: '0',
      qtyStart: '1',
      markStart: '12000',
      markEnd: '12000',
    });
    expect(r.status).not.toBe('unknown');
  });
});
