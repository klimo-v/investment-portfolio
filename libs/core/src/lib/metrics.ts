import Decimal from 'decimal.js';
import type { Operation } from './schemas';

/**
 * Метрики эффективности портфеля/системы (docs/05-review-usability.md §1).
 * Чистые функции без побочных эффектов — легко тестируются на реальных цифрах
 * (CLAUDE.md §7 SRP, §10 тесты финансовой логики). Отделены от движка позиций
 * (engine.ts): движок отвечает «что и сколько», метрики — «насколько эффективно».
 */

/** Денежный поток для XIRR: дата (YYYY-MM-DD) и сумма (− вложение, + возврат) */
export interface CashFlow {
  date: string;
  amount: number;
}

function d(value: string): Decimal {
  return new Decimal(value);
}

function positionKey(op: Operation): string {
  return `${op.instrumentId}|${op.systemId}|${op.portfolioId}`;
}

/** Один лот FIFO-очереди инструмента: часть покупки, ещё не распроданная целиком */
interface Lot {
  /** дата ПОКУПКИ, породившей этот лот — используется как реальная дата оттока */
  buyDate: string;
  /** себестоимость непроданного остатка лота, в рублях (по курсу покупки) */
  costRub: Decimal;
  /** себестоимость непроданного остатка лота, в валюте инструмента */
  costCcy: Decimal;
  /** количество непроданного остатка лота */
  quantity: Decimal;
}

/**
 * Денежные потоки для XIRR за период [periodFrom, today] (docs/05-review-usability.md
 * §2 + баг «задвоение/занижение/завышение XIRR при продаже старой позиции внутри
 * периода», найден и исправлен 2026-08-01). `ops` — ВСЯ история среза (система/
 * портфель), не только периодные — себестоимость лотов иначе была бы искажена.
 * `periodFrom` — начало периода (undefined/null → без периода, потоки строятся по
 * всей истории без синтетики). `currentValueRub` — терминальная стоимость остатка
 * сегодня (0 → терминальный поток не добавляется).
 *
 * Пройдены и отброшены три неверных варианта (числовой пример: 100 акций по
 * 1000₽ куплено ДО periodFrom, 50 продано по 1200₽ ВНУТРИ периода, остаток 50
 * держится и стоит 60 000₽ сегодня):
 * 1) Синтетический отток = себестоимость ВСЕЙ позиции (100000) + продажа даёт
 *    полную выручку (60000) без корректировок → капитал задваивается (потоки
 *    выглядят как рост в 2 раза, хотя цена выросла на 20%).
 * 2) Поток продажи = только realized P&L (10000) → занижает XIRR: себестоимость
 *    проданной доли остаётся «висеть» оттоком до конца, хотя капитал вернулся.
 * 3) Компенсирующий приток НА periodFrom за проданную долю → устраняет задвоение,
 *    но искусственно завышает XIRR (тысячи % годовых): проданная доля технически
 *    «вложена» на periodFrom, хотя реально ею владели с более ранней даты покупки.
 *
 * РЕШЕНИЕ — FIFO по лотам с их РЕАЛЬНЫМИ датами покупки, один проход:
 * каждая покупка — лот с датой/себестоимостью/количеством. Продажа списывает из
 * лотов FIFO; для лота, распроданного ПОЛНОСТЬЮ ИЛИ ЧАСТИЧНО внутри периода,
 * себестоимость списанной части идёт оттоком на РЕАЛЬНУЮ дату покупки лота (а не
 * на periodFrom), а выручка — обычным притоком на дату продажи. Только то, что
 * НЕ было продано и продолжает удерживаться на конец истории, получает
 * синтетический отток на periodFrom (по себестоимости остатка). XIRR считается
 * по всем потокам сразу, включая даты раньше periodFrom, если они относятся к
 * доле, проданной внутри периода, — это корректно для money-weighted return,
 * который по определению зависит от фактических дат вложений.
 *
 * На примере: лот 100@1000 (01.01.2025). Продажа 50 акций 01.09.2025 списывает
 * половину лота — отток 50000 ложится на РЕАЛЬНУЮ дату 01.01.2025 (не periodFrom),
 * приток 60000 — на дату продажи 01.09.2025. Остаток 50 акций держится → отток
 * 50000 на periodFrom (31.07.2025). Терминал: +60000 сегодня. Итог потоков:
 * −50000 (01.01) / +60000 (01.09) / −50000 (31.07) / +60000 (today) — доходность
 * правдоподобна (около +25-30% годовых), без задвоения и без завышения.
 *
 * ВТОРОЙ БАГ, найден при ревью первой версии этого фикса: если Buy сразу добавлял
 * отток на свою дату (для лотов внутри периода), а Sell-ветка ПОВТОРНО добавляла
 * отток на ту же buyDate при списании лота — лот, целиком открытый и закрытый
 * ВНУТРИ периода, получал себестоимость оттоком ДВАЖДЫ (при покупке и при
 * продаже). Инвариант починки: Buy никогда не создаёт поток сразу — каждый лот
 * получает свой единственный отток либо в Sell-ветке при списании (на buyDate),
 * либо в финальном проходе для остатка, который не был распродан (на buyDate,
 * если лот открыт внутри периода, либо на periodFrom, если лот открыт раньше).
 */
export function periodCashFlows(
  ops: Operation[],
  periodFrom: string | undefined,
  currentValueRub: number,
  today: string = new Date().toISOString().slice(0, 10),
): CashFlow[] {
  const sorted = [...ops].sort((a, b) => a.date.localeCompare(b.date));
  const flows: CashFlow[] = [];
  const queues = new Map<string, Lot[]>();

  for (const op of sorted) {
    if (op.operationType === 'Dividend' || op.operationType === 'Coupon') {
      // дивиденды/купоны считаются только внутри периода (или всегда, если период не задан)
      if (!periodFrom || op.date >= periodFrom) {
        const fx = d(op.fxRate ?? '1');
        flows.push({ date: op.date, amount: d(op.quantity).mul(d(op.price)).mul(fx).toNumber() });
      }
      continue;
    }
    if (!op.instrumentId || op.operationType === 'Transfer') continue;

    const key = positionKey(op);
    let queue = queues.get(key);
    if (!queue) {
      queue = [];
      queues.set(key, queue);
    }

    const qty = d(op.quantity);
    const price = d(op.price);
    const fee = d(op.fee ?? '0');
    const fxRate = d(op.fxRate ?? '1');

    if (op.operationType === 'Buy') {
      const costCcy = qty.mul(price).plus(fee);
      // Buy НИКОГДА не даёт поток сразу здесь — себестоимость лота получит РОВНО
      // ОДИН отток позже: либо в Sell-ветке (на buyDate, при списании FIFO, если
      // лот распродаётся), либо в финальном проходе для непроданного остатка (на
      // buyDate — если лот открыт внутри периода, либо на periodFrom — если лот
      // открыт до периода). Добавлять отток здесь ЖЕ было бы вторым источником
      // для того же рубля себестоимости и приводило бы к задвоению оттока для
      // лотов, целиком открытых и закрытых внутри периода (найдено 2026-08-01).
      queue.push({ buyDate: op.date, costRub: costCcy.mul(fxRate), costCcy, quantity: qty });
    } else if (op.operationType === 'Sell') {
      let remaining = qty;
      const proceedsRub = qty.mul(price).minus(fee).mul(fxRate);

      while (remaining.gt(0) && queue.length > 0) {
        const lot = queue[0];
        const take = Decimal.min(remaining, lot.quantity);
        const share = lot.quantity.isZero() ? new Decimal(0) : take.div(lot.quantity);
        const takeCostCcy = lot.costCcy.mul(share);
        // Себестоимость списываемой доли в рублях берём ПРОПОРЦИОНАЛЬНО lot.costRub,
        // т.е. по курсу ПОКУПКИ, а не по fxRate продажи: поток датируется buyDate,
        // и рубли там были потрачены по историческому курсу. Пересчёт через fxRate
        // продажи (было до 2026-08-02) разъезжался с lot.costRub на инструментах в
        // валюте — себестоимость неверно делилась между оттоком на дату покупки и
        // синтетикой на periodFrom, а при сильном росте курса остаток лота уходил
        // в минус и синтетический отток молча терялся (`syntheticOpening.gt(0)`).
        const takeCostRub = lot.costRub.mul(share);

        // без периода — отток на РЕАЛЬНУЮ дату покупки лота (money-weighted по
        // всей истории); с периодом — отток на дату покупки лота ТОЛЬКО если эта
        // продажа попадает внутрь периода (иначе это прошлое, вне окна XIRR, и
        // себестоимость проданного до periodFrom не должна попадать в потоки —
        // ни синтетикой, ни реальной датой)
        if (!periodFrom || op.date >= periodFrom) {
          flows.push({ date: lot.buyDate, amount: -takeCostRub.toNumber() });
        }

        lot.quantity = lot.quantity.minus(take);
        lot.costCcy = lot.costCcy.minus(takeCostCcy);
        lot.costRub = lot.costRub.minus(takeCostRub);
        remaining = remaining.minus(take);
        if (lot.quantity.lte(0)) queue.shift();
      }

      if (!periodFrom || op.date >= periodFrom) {
        flows.push({ date: op.date, amount: proceedsRub.toNumber() });
      }
    }
  }

  // Остатки лотов, НЕ распроданные к концу истории, получают отток РОВНО ОДИН
  // раз здесь: если лот открыт ДО periodFrom — синтетический отток на periodFrom
  // (нельзя использовать реальную дату — она вне окна и обесценит XIRR за период
  // до XIRR почти за всю историю); если лот открыт ВНУТРИ периода (или период не
  // задан) — обычный отток на его РЕАЛЬНУЮ дату покупки.
  let syntheticOpening = new Decimal(0);
  for (const queue of queues.values()) {
    for (const lot of queue) {
      if (lot.quantity.lte(0)) continue;
      if (periodFrom && lot.buyDate < periodFrom) {
        syntheticOpening = syntheticOpening.plus(lot.costRub);
      } else {
        flows.push({ date: lot.buyDate, amount: -lot.costRub.toNumber() });
      }
    }
  }
  if (syntheticOpening.gt(0) && periodFrom) {
    flows.push({ date: periodFrom, amount: -syntheticOpening.toNumber() });
  }

  if (currentValueRub > 0) {
    flows.push({ date: today, amount: currentValueRub });
  }

  return flows;
}

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Минимальный охват потоков для аннуализации (docs/05-review-usability.md §2).
 * XIRR экстраполирует доходность окна на год — на окне короче ~месяца эта
 * экстраполяция становится статистическим шумом (пара недель роста на 2%
 * превращается в тысячи процентов годовых), хотя формула отработала верно.
 * Ниже порога считаем результат неопределённым, а не показываем мусорное число.
 */
const MIN_SPAN_DAYS_FOR_XIRR = 30;

/**
 * Потолок «правдоподобной» годовой доходности (docs/05-review-usability.md §2).
 * Даже на многомесячном окне XIRR может улететь в тысячи процентов, если один
 * поток (например, крупная покупка за пару дней до даты оценки) успел дать
 * быстрый прирост — решение математически верное, но как «годовая доходность»
 * бессмысленное. Выше потолка считаем результат недостоверным и не показываем.
 */
const MAX_PLAUSIBLE_RATE = 5; // +500% годовых

function toTime(date: string): number {
  return new Date(`${date}T00:00:00Z`).getTime();
}

/**
 * XIRR — внутренняя норма доходности с учётом дат и неравномерных вложений
 * (денежно-взвешенная годовая доходность). Возвращает долю (0.184 = +18.4% годовых)
 * или null, если решение не определено (нет и притока, и оттока — доходность
 * посчитать не от чего), окно между первым и последним потоком короче
 * MIN_SPAN_DAYS_FOR_XIRR, либо результат превышает MAX_PLAUSIBLE_RATE —
 * в обоих случаях аннуализация была бы статистическим шумом, а не сигналом.
 *
 * Знак потоков: покупка/ввод денег — отрицательный (капитал ушёл в позицию),
 * продажа/дивиденд/итоговая стоимость остатка — положительный. Ньютон с откатом
 * на бисекцию — надёжнее чистого Ньютона при «плохом» стартовом приближении.
 */
export function xirr(flows: CashFlow[], guess = 0.1): number | null {
  if (flows.length < 2) return null;
  if (!flows.some((f) => f.amount > 0) || !flows.some((f) => f.amount < 0)) return null;

  const t0 = Math.min(...flows.map((f) => toTime(f.date)));
  const t1 = Math.max(...flows.map((f) => toTime(f.date)));
  if ((t1 - t0) / MS_PER_DAY < MIN_SPAN_DAYS_FOR_XIRR) return null;

  const years = (date: string): number => (toTime(date) - t0) / MS_PER_YEAR;

  const npv = (rate: number): number =>
    flows.reduce((sum, f) => sum + f.amount / Math.pow(1 + rate, years(f.date)), 0);
  const dNpv = (rate: number): number =>
    flows.reduce((sum, f) => {
      const y = years(f.date);
      return sum - (y * f.amount) / Math.pow(1 + rate, y + 1);
    }, 0);

  /** Отбрасывает неправдоподобные решения (см. MAX_PLAUSIBLE_RATE) вместо их показа */
  const plausible = (rate: number): number | null =>
    Math.abs(rate) > MAX_PLAUSIBLE_RATE ? null : rate;

  // Ньютон-Рафсон
  let rate = guess;
  for (let i = 0; i < 100; i++) {
    const value = npv(rate);
    const deriv = dNpv(rate);
    if (!Number.isFinite(value) || !Number.isFinite(deriv) || deriv === 0) break;
    const next = rate - value / deriv;
    if (!Number.isFinite(next) || next <= -0.9999) break;
    if (Math.abs(next - rate) < 1e-8) return plausible(next);
    rate = next;
  }

  // Бисекция на [-99.99%, +1000%] — если на концах разные знаки NPV
  let lo = -0.9999;
  let hi = 10;
  let fLo = npv(lo);
  const fHi = npv(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-7) return plausible(mid);
    if (fLo * fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return plausible((lo + hi) / 2);
}

/**
 * Максимальная просадка по ряду стоимости — наибольшее относительное падение от
 * достигнутого пика до последующего дна. Возвращает долю ≤ 0 (−0.123 = −12.3%).
 * Нужна для оценки риска: доходность без просадки — половина картины (§1.5 ревью).
 */
export function maxDrawdown(series: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const value of series) {
    if (value > peak) peak = value;
    if (peak > 0) {
      const drawdown = (value - peak) / peak;
      if (drawdown < worst) worst = drawdown;
    }
  }
  return worst;
}

/** Вход для статистики сделок — минимум полей от Trade/TradeResult */
export interface TradeStatInput {
  status: 'Open' | 'Partial' | 'Closed';
  realizedPnlRub: number;
  openedAt: string;
  closedAt: string | null;
}

/** Агрегированная статистика по закрытым сделкам системы/портфеля (§1.3 ревью) */
export interface TradeStats {
  closedCount: number;
  winCount: number;
  lossCount: number;
  /** доля прибыльных сделок, 0..100 */
  winRatePct: number;
  /** сумма прибылей / сумма убытков; null — если убытков не было */
  profitFactor: number | null;
  /** средняя прибыль по прибыльной сделке (≥ 0) */
  avgWinRub: number;
  /** средний убыток по убыточной сделке (≤ 0) */
  avgLossRub: number;
  /** средний реализованный результат на закрытую сделку (матожидание) */
  expectancyRub: number;
  /** средний срок удержания закрытой сделки в днях */
  avgHoldingDays: number;
}

/**
 * Статистика эффективности стратегии по ЗАКРЫТЫМ сделкам: win rate, profit factor,
 * средний выигрыш/убыток, матожидание, срок удержания. Открытые/частичные сделки
 * не берём — их результат ещё не зафиксирован.
 */
export function tradeStats(trades: TradeStatInput[]): TradeStats {
  const closed = trades.filter((t) => t.status === 'Closed');
  const closedCount = closed.length;

  let grossProfit = 0;
  let grossLoss = 0; // положительная величина суммарного убытка
  let winCount = 0;
  let lossCount = 0;
  let holdingDaysSum = 0;

  for (const t of closed) {
    const pnl = t.realizedPnlRub;
    if (pnl > 0) {
      grossProfit += pnl;
      winCount++;
    } else if (pnl < 0) {
      grossLoss += -pnl;
      lossCount++;
    }
    if (t.closedAt) {
      const days = (toTime(t.closedAt) - toTime(t.openedAt)) / (24 * 60 * 60 * 1000);
      holdingDaysSum += Math.max(0, days);
    }
  }

  return {
    closedCount,
    winCount,
    lossCount,
    winRatePct: closedCount > 0 ? (winCount / closedCount) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    avgWinRub: winCount > 0 ? grossProfit / winCount : 0,
    avgLossRub: lossCount > 0 ? -grossLoss / lossCount : 0,
    expectancyRub: closedCount > 0 ? (grossProfit - grossLoss) / closedCount : 0,
    avgHoldingDays: closedCount > 0 ? holdingDaysSum / closedCount : 0,
  };
}
