import { computed, inject, type Signal } from '@angular/core';
import { PortfolioCalendar } from '../../shared/portfolio-calendar';
import { parseEnum, queryParams } from '../../shared/query-param';
// даты — общая утилита shared: тем же преобразованием пользуется период
// синхронизации с брокером на странице импорта
import { parseIsoDate, toIsoDate } from '../../shared/iso-date';

export { parseIsoDate, toIsoDate };

export const PERIODS = ['all', 'ytd', '1y', 'custom'] as const;
export type Period = (typeof PERIODS)[number];

/** Границы окна; отсутствие границы = «без ограничения» */
export interface PeriodRange {
  from?: string;
  till?: string;
}

/**
 * Период → границы дат. Чистая функция (`today` приходит аргументом, а не берётся
 * из new Date() внутри) — иначе её нельзя протестировать, не подменяя часы.
 *
 * 'custom' без обеих границ ведёт себя как 'all': резать журнал по одной случайно
 * введённой дате хуже, чем не резать вовсе.
 */
export function periodToRange(
  period: Period,
  today: Date,
  from: Date | null,
  till: Date | null,
): PeriodRange {
  if (period === 'all') return {};
  if (period === 'custom') {
    return from && till ? { from: toIsoDate(from), till: toIsoDate(till) } : {};
  }
  const start = new Date(today);
  if (period === 'ytd') start.setMonth(0, 1);
  else start.setFullYear(start.getFullYear() - 1);
  return { from: toIsoDate(start), till: toIsoDate(today) };
}

/** Подпись диапазона для заголовка («01.01.2026 – 29.07.2026»); null — «всё время» */
export function formatRangeLabel(range: PeriodRange): string | null {
  if (!range.from || !range.till) return null;
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  };
  return `${fmt(range.from)} – ${fmt(range.till)}`;
}

/** Чтение и запись фильтра дашборда; состояние физически лежит в query-параметрах */
export interface DashboardFilter {
  readonly system: Signal<string | null>;
  readonly portfolio: Signal<string | null>;
  readonly period: Signal<Period>;
  readonly customFrom: Signal<Date | null>;
  readonly customTill: Signal<Date | null>;
  readonly range: Signal<PeriodRange>;
  readonly ready: Signal<boolean>;
  readonly calendarLoading: Signal<boolean>;
  readonly calendarError: Signal<boolean>;
  retryCalendar(): void;
  readonly error: Signal<string | null>;
  readonly rawFrom: Signal<string | null>;
  readonly rawTill: Signal<string | null>;
  readonly linkParams: Signal<Record<string, string>>;
  setRawRange(from: string | null, till: string | null): void;
  readonly label: Signal<string | null>;
  setSystem(id: string | null): void;
  setPortfolio(id: string | null): void;
  setPeriod(period: Period): void;
  setCustomFrom(date: Date | null): void;
  setCustomTill(date: Date | null): void;
  /** «Произвольный» период с обеими границами одной навигацией (по отдельности вызовы гасят друг друга) */
  setCustomRange(from: Date, till: Date): void;
}

/**
 * Фильтр дашборда поверх адресной строки. Вызывать в контексте инъекции.
 *
 * И страница, и виджет фильтров зовут эту функцию каждый для себя: общее состояние
 * у них — сам URL, а не переданный по ссылке объект. Поэтому виджету не нужен
 * двусторонний биндинг с родителем, а срез переживает F5 и уходит в ссылку.
 */
export function dashboardFilter(): DashboardFilter {
  const params = queryParams();

  const system = params.read('system');
  const portfolio = params.read('portfolio');
  const rawPeriod = params.read('period');
  const rawFrom = params.read('from');
  const rawTill = params.read('till');

  const period = computed<Period>(() => parseEnum(rawPeriod(), PERIODS, 'all'));
  const customFrom = computed(() => parseIsoDate(rawFrom()));
  const customTill = computed(() => parseIsoDate(rawTill()));
  const calendar = inject(PortfolioCalendar);
  const range = computed(() => {
    const day = calendar.today();
    const today = parseIsoDate(day) ?? new Date();
    const r = periodToRange(period(), today, customFrom(), customTill());
    return r.till && day && r.till > day ? { ...r, till: day } : r;
  });
  const error = computed(() => {
    if (period() !== 'custom') return null;
    const rawError = rangeError(rawFrom(), rawTill());
    if (rawError) return rawError;
    const r = range();
    return r.from && r.till && r.from > r.till
      ? 'Весь выбранный период находится в будущем. Начало должно быть не позже текущей даты.'
      : null;
  });
  const ready = computed(
    () =>
      !!calendar.today() &&
      !calendar.context.error() &&
      !error() &&
      (period() !== 'custom' || (!!customFrom() && !!customTill())),
  );
  const linkParams = computed(() => ({
    ...(system() ? { system: system()! } : {}),
    ...(portfolio() ? { portfolio: portfolio()! } : {}),
    period: period(),
    ...(period() === 'custom' ? { from: rawFrom() ?? '', till: rawTill() ?? '' } : {}),
  }));

  return {
    system,
    portfolio,
    period,
    customFrom,
    customTill,
    range,
    ready,
    calendarLoading: calendar.context.isLoading,
    calendarError: computed(() => !!calendar.context.error()),
    retryCalendar: () => {
      calendar.context.reload();
    },
    error,
    rawFrom,
    rawTill,
    linkParams,
    setRawRange: (from, till) => {
      void params.patch({ period: 'custom', from, till });
    },
    label: computed(() => formatRangeLabel(range())),
    setSystem: (id) => params.patch({ system: id }),
    setPortfolio: (id) => params.patch({ portfolio: id }),
    setPeriod: (next) =>
      // Одной навигацией: период и обнуление границ разными вызовами гасили друг
      // друга, и период в адрес не попадал вовсе (см. shared/query-param.ts).
      // Границы имеют смысл только у 'custom' — иначе в адресе остаётся мусор,
      // который при следующем переключении на «Произвольный» молча всплывёт обратно.
      params.patch(
        next === 'custom'
          ? { period: next }
          : { period: next === 'all' ? null : next, from: null, till: null },
      ),
    setCustomFrom: (date) => params.patch({ from: date ? toIsoDate(date) : null }),
    setCustomTill: (date) => params.patch({ till: date ? toIsoDate(date) : null }),
    setCustomRange: (from, till) =>
      params.patch({ period: 'custom', from: toIsoDate(from), till: toIsoDate(till) }),
  };
}

/** Missing bounds are unfinished input; impossible dates and reversed bounds are errors. */
export function rangeError(from: string | null, till: string | null): string | null {
  const partial = (v: string) => /^[0-9.-]+$/.test(v) && v.length < 10;
  if (from && !parseIsoDate(from) && !partial(from))
    return 'Начало: несуществующая дата. Введите ДД.ММ.ГГГГ.';
  if (till && !parseIsoDate(till) && !partial(till))
    return 'Конец: несуществующая дата. Введите ДД.ММ.ГГГГ.';
  if (from && till && parseIsoDate(from) && parseIsoDate(till) && from > till)
    return 'Начало периода не может быть позже конца.';
  return null;
}
