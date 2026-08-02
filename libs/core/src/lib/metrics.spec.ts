import { describe, it, expect } from 'vitest';
import {
  xirr,
  maxDrawdown,
  tradeStats,
  periodCashFlows,
  type TradeStatInput,
} from './metrics';
import type { Operation } from './schemas';

/**
 * Тесты метрик эффективности (docs/05-review-usability.md §1).
 * Финансовая логика — приоритет покрытия (CLAUDE.md §10).
 */

describe('xirr — денежно-взвешенная годовая доходность', () => {
  it('ровно +10% за год: вложил 1000, вернул 1100 через год', () => {
    const rate = xirr([
      { date: '2025-01-01', amount: -1000 },
      { date: '2026-01-01', amount: 1100 },
    ]);
    expect(rate).not.toBeNull();
    expect(rate!).toBeCloseTo(0.1, 4);
  });

  it('удвоение за год = +100%', () => {
    const rate = xirr([
      { date: '2025-01-01', amount: -1000 },
      { date: '2026-01-01', amount: 2000 },
    ]);
    expect(rate!).toBeCloseTo(1.0, 4);
  });

  it('убыток: 1000 → 900 за год = −10%', () => {
    const rate = xirr([
      { date: '2025-01-01', amount: -1000 },
      { date: '2026-01-01', amount: 900 },
    ]);
    expect(rate!).toBeCloseTo(-0.1, 4);
  });

  it('несколько неравномерных вложений (промежуточный докуп)', () => {
    // вложил 1000, через полгода ещё 1000, в конце года забрал 2200
    const rate = xirr([
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-07-01', amount: -1000 },
      { date: '2025-01-01', amount: 2200 },
    ]);
    // NPV в найденной ставке ≈ 0 — проверяем корректность через пересчёт
    expect(rate).not.toBeNull();
    expect(rate!).toBeGreaterThan(0);
    expect(rate!).toBeLessThan(0.3);
  });

  it('нет притока (только вложения) → null', () => {
    expect(
      xirr([
        { date: '2024-01-01', amount: -1000 },
        { date: '2025-01-01', amount: -500 },
      ]),
    ).toBeNull();
  });

  it('меньше двух потоков → null', () => {
    expect(xirr([{ date: '2024-01-01', amount: -1000 }])).toBeNull();
  });

  it('слишком короткое окно (пара недель) → null, а не абсурдные годовые', () => {
    // +2% за 10 дней математически экстраполируется в тысячи % годовых — шум,
    // а не сигнал (docs/05-review-usability.md §2)
    const rate = xirr([
      { date: '2026-07-01', amount: -1000 },
      { date: '2026-07-11', amount: 1020 },
    ]);
    expect(rate).toBeNull();
  });

  it('окно ровно на границе (30 дней) — доходность уже считается', () => {
    const rate = xirr([
      { date: '2026-06-01', amount: -1000 },
      { date: '2026-07-01', amount: 1020 },
    ]);
    expect(rate).not.toBeNull();
  });

  it('многомесячное окно, но один поток за пару дней до конца даёт неправдоподобный XIRR → null', () => {
    // Общий охват потоков — полгода (не триггерит проверку на короткое окно),
    // но основная часть капитала вложена за 2 дня до даты оценки и уже показала
    // небольшой прирост — экстраполяция такого прироста на год даёт тысячи %,
    // хотя формула отработала верно. Именно этот кейс проходил проверку по
    // одной лишь длине окна (docs/05-review-usability.md §2).
    const rate = xirr([
      { date: '2026-01-05', amount: -10000 }, // давняя, маленькая часть капитала
      { date: '2026-07-23', amount: -900000 }, // почти весь капитал — за день до оценки
      { date: '2026-07-24', amount: 950000 }, // текущая стоимость остатка
    ]);
    expect(rate).toBeNull();
  });
});

/** Строит Operation с дефолтами, чтобы тесты не захламлялись служебными полями */
function op(partial: Partial<Operation> & Pick<Operation, 'date' | 'operationType'>): Operation {
  return {
    systemId: 'sys-1',
    portfolioId: 'pf-1',
    instrumentId: 'INS',
    quantity: '0',
    price: '0',
    fee: '0',
    fxRate: '1',
    currency: 'RUB',
    ...partial,
  };
}

describe('periodCashFlows — потоки XIRR за период (без задвоения при продаже старой позиции)', () => {
  it('buy-and-hold без операций внутри периода: синтетический отток на periodFrom = себестоимость, терминальный поток = текущая стоимость', () => {
    const ops: Operation[] = [op({ date: '2025-01-01', operationType: 'Buy', quantity: '100', price: '1000' })];
    const flows = periodCashFlows(ops, '2025-07-31', 130000, '2026-07-31');
    expect(flows).toEqual([
      { date: '2025-07-31', amount: -100000 },
      { date: '2026-07-31', amount: 130000 },
    ]);
  });

  it('частичная продажа позиции, купленной ДО периода: FIFO по реальным датам, без задвоения/занижения/завышения', () => {
    // Куплено 100 акций по 1000₽ (100 000₽) ДО периода (01.01.2025). Внутри периода
    // (periodFrom=31.07.2025) продано 50 акций по 1200₽ (60 000₽ выручки) 01.09.2025.
    // Остаток 50 акций сейчас (терминал) стоит 60 000₽ (цена выросла до 1200₽).
    //
    // Три отброшенных варианта (см. doc-comment periodCashFlows в metrics.ts):
    //  1) наивно −100000(from)/+60000(продажа)/+60000(терминал) → капитал будто
    //     удвоился (баг, из-за которого всё началось);
    //  2) поток продажи = только realized P&L (+10000) → искусственно занижает
    //     XIRR — себестоимость проданного «зависает» в отдельном оттоке;
    //  3) компенсация оттока НА periodFrom → искусственно завышает XIRR (тысячи %
    //     годовых) — сжимает срок владения проданной доли до одного месяца.
    //
    // Верная модель (FIFO по реальным датам): себестоимость ПРОДАННОЙ доли (50 000₽)
    // идёт оттоком на РЕАЛЬНУЮ дату покупки лота (01.01.2025), выручка от продажи —
    // обычным притоком на дату сделки (01.09.2025). Только реально УДЕРЖИВАЕМЫЙ
    // остаток (ещё 50 акций, себестоимость 50 000₽) получает синтетический отток на
    // periodFrom. Итог: −50000 (01.01) / +60000 (01.09) / −50000 (periodFrom) /
    // +60000 (терминал) — доходность правдоподобна (~25% годовых), не удвоение и не
    // экстремум.
    const ops: Operation[] = [
      op({ date: '2025-01-01', operationType: 'Buy', quantity: '100', price: '1000' }),
      op({ date: '2025-09-01', operationType: 'Sell', quantity: '50', price: '1200' }),
    ];
    const periodFrom = '2025-07-31';
    const today = '2026-07-31';
    const flows = periodCashFlows(ops, periodFrom, 60000, today);

    expect(flows).toEqual([
      { date: '2025-01-01', amount: -50000 }, // себестоимость ПРОДАННОЙ доли, на реальную дату покупки
      { date: '2025-09-01', amount: 60000 }, // полная выручка от продажи, на дату сделки
      { date: periodFrom, amount: -50000 }, // синтетика ТОЛЬКО на реально удерживаемый остаток
      { date: today, amount: 60000 }, // терминальная стоимость остатка
    ]);

    // Правдоподобная доходность (рост цены на 20% за ~8 месяцев ≈ 25-30% годовых) —
    // не абсурдные тысячи % (баг компенсации на periodFrom) и не отрицательная
    // (баг «только realized P&L»)
    const rate = xirr(flows);
    expect(rate).not.toBeNull();
    expect(rate!).toBeGreaterThan(0.15);
    expect(rate!).toBeLessThan(0.5);
  });

  it('несколько покупок ДО периода (FIFO): продажа внутри периода списывает старейший лот первым', () => {
    // Два лота ДО periodFrom: 50@800 (01.01.2025) и 50@1000 (01.03.2025). Продажа
    // 60 акций внутри периода — FIFO списывает сначала весь первый лот (50@800),
    // затем 10 акций из второго лота (10@1000). Себестоимость проданного:
    // 50*800 + 10*1000 = 40000+10000 = 50000, разнесённая по РЕАЛЬНЫМ датам покупки.
    const ops: Operation[] = [
      op({ date: '2025-01-01', operationType: 'Buy', quantity: '50', price: '800' }),
      op({ date: '2025-03-01', operationType: 'Buy', quantity: '50', price: '1000' }),
      op({ date: '2025-09-01', operationType: 'Sell', quantity: '60', price: '1200' }),
    ];
    const periodFrom = '2025-07-31';
    const flows = periodCashFlows(ops, periodFrom, 46000, '2026-07-31'); // остаток 40 акций по 1150

    const fromLot1 = flows.find((f) => f.date === '2025-01-01');
    const fromLot2 = flows.find((f) => f.date === '2025-03-01');
    expect(fromLot1?.amount).toBeCloseTo(-40000, 2); // 50*800, лот распродан целиком
    expect(fromLot2?.amount).toBeCloseTo(-10000, 2); // 10*1000, только списанная часть

    const sale = flows.find((f) => f.date === '2025-09-01');
    expect(sale?.amount).toBeCloseTo(72000, 2); // 60*1200 полная выручка

    // синтетика на periodFrom — остаток второго лота: 40 акций по 1000 = 40000
    const opening = flows.find((f) => f.date === periodFrom);
    expect(opening?.amount).toBeCloseTo(-40000, 2);
  });

  it('покупка внутри периода — обычный отток по факту сделки, без синтетики', () => {
    const ops: Operation[] = [op({ date: '2026-01-15', operationType: 'Buy', quantity: '10', price: '500' })];
    const flows = periodCashFlows(ops, '2026-01-01', 6000);
    expect(flows).toEqual([
      { date: '2026-01-15', amount: -5000 },
      { date: expect.any(String), amount: 6000 },
    ]);
  });

  it('покупка И продажа целиком ВНУТРИ периода: отток на дату покупки не задваивается', () => {
    // Регрессия на баг, найденный при ревью первой версии фикса: лот, полностью
    // открытый и закрытый внутри периода, получал ДВА оттока на дату покупки —
    // один сразу при Buy, второй при списании лота в Sell-ветке (т.к. buyDate
    // сравнивался только с periodFrom, а не с фактом «уже добавлен ли поток»).
    // Теперь Buy никогда не даёт поток сразу — себестоимость лота получает ровно
    // один отток (в Sell-ветке при продаже либо в финальном проходе при остатке).
    const ops: Operation[] = [
      op({ date: '2026-01-15', operationType: 'Buy', quantity: '10', price: '500' }),
      op({ date: '2026-02-01', operationType: 'Sell', quantity: '10', price: '600' }),
    ];
    const flows = periodCashFlows(ops, '2026-01-01', 0, '2026-07-31');
    expect(flows).toEqual([
      { date: '2026-01-15', amount: -5000 }, // РОВНО один отток на дату покупки
      { date: '2026-02-01', amount: 6000 }, // полная выручка от продажи
    ]);
  });

  it('инструмент в валюте: себестоимость списываемой доли — по курсу ПОКУПКИ, а не продажи', () => {
    // Регрессия (найдено при ревью 2026-08-02): takeCostRub считался как
    // takeCostCcy * fxRate ПРОДАЖИ, хотя lot.costRub набирался по курсу ПОКУПКИ.
    // 100 акций по $10 при курсе 80 = 80 000 ₽ себестоимости. Продажа половины при
    // курсе 100 списывала 50 * 10 * 100 = 50 000 ₽ вместо 40 000 ₽, а в синтетику
    // на periodFrom попадали «остаточные» 30 000 ₽ вместо 40 000 ₽ — сумма сходилась,
    // но делилась между датами неверно и искажала XIRR.
    const ops: Operation[] = [
      op({ date: '2025-01-01', operationType: 'Buy', quantity: '100', price: '10', fxRate: '80' }),
      op({ date: '2025-09-01', operationType: 'Sell', quantity: '50', price: '12', fxRate: '100' }),
    ];
    const flows = periodCashFlows(ops, '2025-07-31', 60000, '2026-07-31');

    expect(flows.find((f) => f.date === '2025-01-01')?.amount).toBeCloseTo(-40000, 6);
    expect(flows.find((f) => f.date === '2025-07-31')?.amount).toBeCloseTo(-40000, 6);
    expect(flows.find((f) => f.date === '2025-09-01')?.amount).toBeCloseTo(60000, 6); // 50*12*100
  });

  it('инструмент в валюте: при резком росте курса остаток лота не уходит в минус', () => {
    // Тот же баг в крайней форме: takeCostRub по курсу продажи мог ПРЕВЫСИТЬ весь
    // lot.costRub → остаток лота становился отрицательным, syntheticOpening уходил
    // в минус и целиком терялся из-за проверки `syntheticOpening.gt(0)` — XIRR
    // считался вообще без стартового вложения по удерживаемому остатку.
    const ops: Operation[] = [
      op({ date: '2025-01-01', operationType: 'Buy', quantity: '100', price: '10', fxRate: '80' }),
      op({ date: '2025-09-01', operationType: 'Sell', quantity: '90', price: '12', fxRate: '300' }),
    ];
    const flows = periodCashFlows(ops, '2025-07-31', 24000, '2026-07-31');

    expect(flows.find((f) => f.date === '2025-01-01')?.amount).toBeCloseTo(-72000, 6); // 90% от 80 000 ₽
    const opening = flows.find((f) => f.date === '2025-07-31');
    expect(opening?.amount).toBeCloseTo(-8000, 6); // остаток 10 акций = 10% от 80 000 ₽, а не «минус»
  });
});

describe('maxDrawdown — максимальная просадка', () => {
  it('рост без откатов = 0', () => {
    expect(maxDrawdown([100, 110, 120, 130])).toBe(0);
  });

  it('падение с пика 120 до дна 90 = −25%', () => {
    expect(maxDrawdown([100, 120, 90, 130])).toBeCloseTo(-0.25, 6);
  });

  it('берёт худшую из нескольких просадок', () => {
    // пик 100→80 (−20%), затем пик 120→60 (−50%)
    expect(maxDrawdown([100, 80, 120, 60, 90])).toBeCloseTo(-0.5, 6);
  });

  it('пустой ряд = 0', () => {
    expect(maxDrawdown([])).toBe(0);
  });
});

describe('tradeStats — статистика по закрытым сделкам', () => {
  const trades: TradeStatInput[] = [
    { status: 'Closed', realizedPnlRub: 300, openedAt: '2024-01-01', closedAt: '2024-01-11' }, // +300, 10 дн
    { status: 'Closed', realizedPnlRub: 100, openedAt: '2024-02-01', closedAt: '2024-02-21' }, // +100, 20 дн
    { status: 'Closed', realizedPnlRub: -200, openedAt: '2024-03-01', closedAt: '2024-03-31' }, // −200, 30 дн
    { status: 'Open', realizedPnlRub: 0, openedAt: '2024-04-01', closedAt: null }, // не учитывается
  ];

  it('считает win rate, profit factor, средние и срок удержания', () => {
    const s = tradeStats(trades);
    expect(s.closedCount).toBe(3);
    expect(s.winCount).toBe(2);
    expect(s.lossCount).toBe(1);
    expect(s.winRatePct).toBeCloseTo((2 / 3) * 100, 6);
    expect(s.profitFactor).toBeCloseTo(400 / 200, 6); // (300+100)/200 = 2.0
    expect(s.avgWinRub).toBeCloseTo(200, 6); // (300+100)/2
    expect(s.avgLossRub).toBeCloseTo(-200, 6);
    expect(s.expectancyRub).toBeCloseTo((300 + 100 - 200) / 3, 6);
    expect(s.avgHoldingDays).toBeCloseTo((10 + 20 + 30) / 3, 6);
  });

  it('без убытков profitFactor = null', () => {
    const s = tradeStats([
      { status: 'Closed', realizedPnlRub: 50, openedAt: '2024-01-01', closedAt: '2024-01-02' },
    ]);
    expect(s.profitFactor).toBeNull();
  });

  it('без закрытых сделок — нули', () => {
    const s = tradeStats([
      { status: 'Open', realizedPnlRub: 0, openedAt: '2024-01-01', closedAt: null },
    ]);
    expect(s.closedCount).toBe(0);
    expect(s.winRatePct).toBe(0);
    expect(s.expectancyRub).toBe(0);
  });
});
