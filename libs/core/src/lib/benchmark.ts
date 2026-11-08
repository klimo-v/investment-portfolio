/**
 * Ориентиры для сравнения с портфелем («Портфель против рынка»).
 *
 * Ориентир сравнивается с TWR портфеля — обе величины очищены от ваших вводов и выводов,
 * поэтому ряд ориентира — это индекс на базе 100 на первый день периода.
 *
 * Дивиденды вашего журнала приходят «налог удержан», поэтому честный ориентир по умолчанию —
 * MCFTRR (индекс МосБиржи полной доходности, нетто: дивиденды за вычетом налога для резидентов).
 * IMOEX — ценовой индекс без дивидендов; остаётся выбираемым с пометкой.
 *
 * RUSFAR — не индекс, а ставка денежного рынка (% годовых); из ставки собирается накопленный
 * индекс «что дал бы денежный рынок» — он заменяет прежнюю константу 16% годовых.
 */

export interface BenchmarkOption {
  secid: string;
  label: string;
  /** одна строка пояснения под переключателем */
  note: string;
}

export const BENCHMARK_INDEXES: readonly BenchmarkOption[] = [
  {
    secid: 'MCFTRR',
    label: 'МосБиржи, полная доходность (нетто)',
    note: 'Индекс МосБиржи с реинвестированием дивидендов за вычетом налога — честное сравнение для портфеля с дивидендами.',
  },
  {
    secid: 'RGBITR',
    label: 'ОФЗ, полная доходность',
    note: 'Индекс гособлигаций (ОФЗ) полной доходности: цена плюс купоны.',
  },
  {
    secid: 'RUCBTRNS',
    label: 'Корп. облигации, полная доходность',
    note: 'Индекс корпоративных облигаций полной доходности (чистый).',
  },
  {
    secid: 'IMOEX',
    label: 'IMOEX (ценовой, без дивидендов)',
    note: 'Ценовой индекс МосБиржи без дивидендов: портфель с дивидендами сравнивать с ним нечестно, он занижает рынок.',
  },
];

export const DEFAULT_BENCHMARK = 'MCFTRR';

/** Ставка денежного рынка для линии «Денежный рынок» */
export const MONEY_MARKET = { secid: 'RUSFAR', label: 'Денежный рынок (RUSFAR)' } as const;

/** Допустимые SECID запроса: четыре индекса и ставка денежного рынка */
export function isBenchmarkSecid(secid: string): boolean {
  return secid === MONEY_MARKET.secid || BENCHMARK_INDEXES.some((b) => b.secid === secid);
}

/** id ряда в price_history: отдельное пространство имён, чтобы не пересекаться с тикерами и `fx:` */
export function benchmarkInstrumentId(secid: string): string {
  return `index:${secid.toUpperCase()}`;
}

export interface BenchmarkObservation {
  date: string;
  value: number;
}

export interface IndexPoint {
  date: string;
  /** уровень на базе 100 в первый день ряда */
  index: number;
}

const DAY_MS = 86_400_000;

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Календарные дни [from, till] включительно */
function daysOf(from: string, till: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= till; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Значение «на дату или раньше»: наблюдения по возрастанию; null — раньше первого наблюдения */
function lastOnOrBefore(sorted: readonly BenchmarkObservation[], from: number, date: string): number {
  let i = from;
  while (i + 1 < sorted.length && sorted[i + 1].date <= date) i++;
  return i;
}

/**
 * Индекс на базе 100 на `from` по закрытиям индекса: на каждый календарный день — последнее
 * закрытие на дату или раньше (торговли в выходные нет). Если история начинается позже
 * `from`, ряд начинается с первой даты, на которую данные есть. Нет данных → пустой ряд.
 */
export function indexSeries(observations: readonly BenchmarkObservation[], from: string, till: string): IndexPoint[] {
  const sorted = [...observations].filter((o) => o.value > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0 || from > till) return [];
  const start = sorted[0].date > from ? sorted[0].date : from;
  if (start > till) return [];
  let pos = -1;
  const out: IndexPoint[] = [];
  let base: number | null = null;
  for (const day of daysOf(start, till)) {
    pos = lastOnOrBefore(sorted, Math.max(pos, 0), day);
    if (sorted[pos].date > day) continue;
    const value = sorted[pos].value;
    base ??= value;
    out.push({ date: day, index: (value / base) * 100 });
  }
  return out;
}

/**
 * Накопленный индекс по ставке (% годовых) на базе 100 на `from`: на каждый календарный день
 * уровень растёт на ставку этого дня / 365; в выходные действует ставка последнего рабочего дня.
 * До первой опубликованной ставки берётся первая известная. Нет данных → пустой ряд.
 */
export function rateIndexSeries(rates: readonly BenchmarkObservation[], from: string, till: string): IndexPoint[] {
  const sorted = [...rates].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0 || from > till) return [];
  let pos = 0;
  let level = 100;
  const out: IndexPoint[] = [];
  daysOf(from, till).forEach((day, i) => {
    pos = lastOnOrBefore(sorted, pos, day);
    if (i > 0) level *= 1 + sorted[pos].value / 100 / 365;
    out.push({ date: day, index: level });
  });
  return out;
}
