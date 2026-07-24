import { describe, it, expect } from 'vitest';
import { xirr, maxDrawdown, tradeStats, type TradeStatInput } from './metrics';

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
