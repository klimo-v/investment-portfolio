/**
 * Эталоны для единого расчёта периода (docs/tasks/unified-performance-prompt.md, этап 0).
 *
 * Синтетические сценарии с ВРУЧНУЮ посчитанными ответами. Они фиксируют ожидаемый смысл
 * трёх метрик ДО того, как появится `periodPerformance`, и дальше служат входом его тестов:
 *  - результат, ₽  = V_end − V_start − ΣF;
 *  - TWR           = цепочка дневных доходностей (ввод в начале дня, вывод в конце);
 *  - MWR / XIRR    = внутренняя норма по потокам: отток V_start (по РЫНКУ) на дату базы,
 *                    внешние потоки на их даты, приток V_end на конец периода.
 *
 * Точка ряда — тот же срез, что даёт valuationSeries для всего портфеля: богатство
 * V = netContributionsRub + totalRub (позиции + кэш), поток F = изменение netContributionsRub.
 * Первая точка — БАЗА периода (последний день ДО `from`, V_start); результат считается после неё.
 *
 * Для XIRR все сценарии идут ровно 365 дней, поэтому доходность в годовых равна доходности
 * за период (годовая дробь = дни / 365 — как в metrics.ts).
 */

export interface FixturePoint {
  date: string;
  /** рыночная стоимость позиций (для проверки «продажа переливает стоимость в кэш») */
  marketValueRub: number;
  /** fixedRub + unrealizedRub нарастающим итогом с начала истории */
  totalRub: number;
  /** чистый ввод нарастающим итогом: Deposit − Withdraw */
  netContributionsRub: number;
}

export interface PeriodFixture {
  name: string;
  description: string;
  /** первая точка — база периода (V_start), остальные — внутри периода */
  points: FixturePoint[];
  expected: {
    /** V_end − V_start − ΣF, ₽ */
    resultRub: number;
    /** TWR как индекс на базе 100 в конце периода */
    twrIndex: number;
    /** XIRR / MWR за период (= в годовых, период ровно 365 дней), %, допуск см. `mwrTolerancePp` */
    mwrPct: number;
    mwrTolerancePp: number;
  };
}

/** 1. Без потоков: капитал 100 000, за год +10 000 → TWR = MWR = простая доходность 10% */
const noFlows: PeriodFixture = {
  name: 'noFlows',
  description: 'Без потоков: TWR = MWR = простая доходность',
  points: [
    { date: '2024-12-31', marketValueRub: 100_000, totalRub: 0, netContributionsRub: 100_000 },
    { date: '2025-12-31', marketValueRub: 110_000, totalRub: 10_000, netContributionsRub: 100_000 },
  ],
  // V: 100 000 → 110 000, F = 0. Результат 10 000; индекс 100·1,10; (1+r)^1 = 1,10 → r = 10%
  expected: { resultRub: 10_000, twrIndex: 110, mwrPct: 10, mwrTolerancePp: 0.01 },
};

/**
 * 2. Ввод в середине периода ПЕРЕД нулевым ростом: первая половина +10% на 100 000, затем довнесено
 * ещё 100 000, и вторая половина — 0%. TWR (10%) ≠ MWR (≈6,7%): ваши деньги работали хуже стратегии.
 */
const midDepositBeforeFlat: PeriodFixture = {
  name: 'midDepositBeforeFlat',
  description: 'Ввод в середине периода: TWR ≠ MWR',
  points: [
    { date: '2024-12-31', marketValueRub: 100_000, totalRub: 0, netContributionsRub: 100_000 },
    // конец первой половины: +10% → V = 110 000 (цена выросла, потока ещё нет)
    { date: '2025-07-01', marketValueRub: 110_000, totalRub: 10_000, netContributionsRub: 100_000 },
    // довнесено 100 000 (V = 210 000), в этот же день доходность 0: ввод — в начале дня
    { date: '2025-07-02', marketValueRub: 210_000, totalRub: 10_000, netContributionsRub: 200_000 },
    // вторая половина — без роста
    { date: '2025-12-31', marketValueRub: 210_000, totalRub: 10_000, netContributionsRub: 200_000 },
  ],
  // Результат: 210 000 − 100 000 − 100 000 = 10 000.
  // TWR: 110/100 · 210/(110+100)=1,00 · 1,00 = 1,10 → 110.
  // MWR: −100 000 в t=0, −100 000 в t≈0,5, +210 000 в t=1. x = (1+r)^0,5:
  //   x² + x = 2,1 → x = (−1 + √9,4)/2 ≈ 1,03297 → r ≈ 6,70% (дробь 182/365, а не ровно 0,5 → допуск 0,3 п.п.)
  expected: { resultRub: 10_000, twrIndex: 110, mwrPct: 6.7, mwrTolerancePp: 0.3 },
};

/**
 * 3. Продажа в кэш: бумага с прибылью продана — стоимость позиций падает в ноль, но богатство
 * (позиции + кэш) не меняется, доходность дня нулевая.
 */
const saleToCash: PeriodFixture = {
  name: 'saleToCash',
  description: 'Продажа в кэш не меняет богатство',
  points: [
    { date: '2024-12-31', marketValueRub: 100_000, totalRub: 0, netContributionsRub: 100_000 },
    // цена +5% (нереализованное 5 000), V = 105 000
    { date: '2025-06-30', marketValueRub: 105_000, totalRub: 5_000, netContributionsRub: 100_000 },
    // продано целиком по этой цене: позиций нет, прибыль перешла в «зафиксированное», V = 105 000
    { date: '2025-07-01', marketValueRub: 0, totalRub: 5_000, netContributionsRub: 100_000 },
    { date: '2025-12-31', marketValueRub: 0, totalRub: 5_000, netContributionsRub: 100_000 },
  ],
  // Результат 105 000 − 100 000 = 5 000; индекс 105 (день продажи доходности не даёт); r = 5%
  expected: { resultRub: 5_000, twrIndex: 105, mwrPct: 5, mwrTolerancePp: 0.01 },
};

/** 4. Купон: цена не менялась, выплачено 3 000 → результат и TWR 3% (выплата — прибыль, не ввод) */
const coupon: PeriodFixture = {
  name: 'coupon',
  description: 'Купон — доходность, а не ввод денег',
  points: [
    { date: '2024-12-31', marketValueRub: 100_000, totalRub: 0, netContributionsRub: 100_000 },
    // купон 3 000 упал в кэш: позиция стоит как прежде, «зафиксированное» +3 000
    { date: '2025-06-30', marketValueRub: 100_000, totalRub: 3_000, netContributionsRub: 100_000 },
    { date: '2025-12-31', marketValueRub: 100_000, totalRub: 3_000, netContributionsRub: 100_000 },
  ],
  expected: { resultRub: 3_000, twrIndex: 103, mwrPct: 3, mwrTolerancePp: 0.01 },
};

/**
 * 5. Вывод денег: V = 200 000 → +10% (220 000) → выведено 50 000 (V = 170 000, доходность дня 0:
 * вывод — в конце дня) → ещё +10% (187 000). Оба метода дают 21%: постоянный рост на любом капитале.
 */
const withdrawal: PeriodFixture = {
  name: 'withdrawal',
  description: 'Вывод денег не режет доходность',
  points: [
    { date: '2024-12-31', marketValueRub: 200_000, totalRub: 0, netContributionsRub: 200_000 },
    { date: '2025-07-01', marketValueRub: 220_000, totalRub: 20_000, netContributionsRub: 200_000 },
    // выведено 50 000: чистый ввод 150 000, позиции 170 000, итог не менялся
    { date: '2025-07-02', marketValueRub: 170_000, totalRub: 20_000, netContributionsRub: 150_000 },
    // +10% на 170 000 = +17 000
    { date: '2025-12-31', marketValueRub: 187_000, totalRub: 37_000, netContributionsRub: 150_000 },
  ],
  // Результат: 187 000 − 200 000 − (−50 000) = 37 000.
  // TWR: 1,10 · (170 000 + 50 000 − 220 000 → 0) · 1,10 = 1,21 → 121.
  // MWR: −200 000 в t=0, +50 000 в t≈0,5, +187 000 в t=1 → x = (1+r)^0,5: 200x² − 50x − 187 = 0,
  //   x = (50 + √152 100)/400 = (50 + 390)/400 = 1,10 → r = 21% (допуск на 182/365)
  expected: { resultRub: 37_000, twrIndex: 121, mwrPct: 21, mwrTolerancePp: 0.3 },
};

/**
 * 6. Период начинается с УЖЕ открытыми позициями: куплено на 100 000 до периода, к его началу
 * позиция стоит 150 000 (+50 000 бумажной прибыли — заработана ДО периода). За период +15 000.
 * База — рынок (150 000), поэтому результат 15 000 и 10%, а не 65 000 и 65% «от себестоимости».
 */
const openAtStart: PeriodFixture = {
  name: 'openAtStart',
  description: 'Открытые позиции на начало периода — база по рынку, не по себестоимости',
  points: [
    { date: '2024-12-31', marketValueRub: 150_000, totalRub: 50_000, netContributionsRub: 100_000 },
    { date: '2025-12-31', marketValueRub: 165_000, totalRub: 65_000, netContributionsRub: 100_000 },
  ],
  // Результат 165 000 − 150 000 = 15 000 (а не 65 000); TWR 165/150 = 1,10; (1+r)^1 = 1,10 → 10%
  expected: { resultRub: 15_000, twrIndex: 110, mwrPct: 10, mwrTolerancePp: 0.01 },
};

export const PERIOD_FIXTURES: readonly PeriodFixture[] = [
  noFlows,
  midDepositBeforeFlat,
  saleToCash,
  coupon,
  withdrawal,
  openAtStart,
];
