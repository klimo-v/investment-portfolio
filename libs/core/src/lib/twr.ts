import Decimal from 'decimal.js';

/**
 * Примитивы time-weighted return (TWR) на Decimal — единственная реализация цепочки
 * дневных доходностей: из неё считаются и `timeWeightedIndex` (valuation.ts), и
 * `periodPerformance` (period-performance.ts).
 *
 * Дневная доходность при капитале V и внешнем потоке F (+ = деньги внутрь):
 *   r = (V_t − V_{t−1} − F_t) / (V_{t−1} + max(F_t, 0))
 * Соглашение: ввод работает с НАЧАЛА дня (входит в базу — на него покупают и платят
 * комиссии), вывод снимается в КОНЦЕ дня (на базу не влияет). Так вклад 2 млн ₽ после
 * почти нулевого остатка не даёт ложной просадки −81%.
 *
 * Если капитала предыдущего дня нет (V_{t−1} < 0) или база нулевая — доходность дня 0
 * (делить не на что). V_{t−1} = 0 допустимо, когда в этот день пришёл ввод: база = ввод.
 */

Decimal.set({ precision: 40 });

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);

/** Доходность одного дня; null — дня нет в расчёте (нет капитала) */
export function twrDayReturn(prev: Decimal, value: Decimal, flow: Decimal): Decimal | null {
  if (prev.lt(0)) return null;
  const base = prev.plus(flow.gt(0) ? flow : ZERO);
  // Decimal.isPositive() истинно и для нуля — проверяем строго
  if (!base.gt(0)) return null;
  return value.minus(prev).minus(flow).div(base);
}

export interface TwrInput {
  value: Decimal;
  /** внешний поток дня: + деньги внутрь, − наружу */
  flow: Decimal;
}

export interface TwrResult {
  /** уровень индекса ПОСЛЕ каждого дня, база 100 */
  levels: Decimal[];
  /** сколько дней вошло в расчёт (с ненулевой базой) */
  capitalDays: number;
}

/**
 * Цепочка (1 + r). `prev` — капитал дня ДО первой точки; null — первая точка стартовая
 * (доходности за неё нет, уровень 100).
 */
export function twrLevels(days: readonly TwrInput[], prev: Decimal | null): TwrResult {
  const levels: Decimal[] = [];
  let level = HUNDRED;
  let capitalDays = 0;
  let prevValue = prev;
  for (const d of days) {
    if (prevValue !== null) {
      const r = twrDayReturn(prevValue, d.value, d.flow);
      if (r !== null) {
        level = level.mul(r.plus(1));
        capitalDays++;
      }
    }
    levels.push(level);
    prevValue = d.value;
  }
  return { levels, capitalDays };
}
