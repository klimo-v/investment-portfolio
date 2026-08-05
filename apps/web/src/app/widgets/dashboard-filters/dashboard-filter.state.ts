import { computed, type Signal } from '@angular/core';
import { parseEnum, queryParams } from '../../shared/query-param';

export const PERIODS = ['all', 'ytd', '1y', 'custom'] as const;
export type Period = (typeof PERIODS)[number];

/** Границы окна; отсутствие границы = «без ограничения» */
export interface PeriodRange {
  from?: string;
  till?: string;
}

/**
 * Дата пикера → YYYY-MM-DD по ЛОКАЛЬНЫМ компонентам, не через toISOString():
 * тот конвертирует через UTC и на выбранной пользователем календарной дате
 * (локальная полночь) может откатить день назад в зависимости от часового пояса —
 * пользователь выбрал 1 июля, а фильтр получил бы 30 июня.
 */
export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * YYYY-MM-DD из адресной строки → Date в ЛОКАЛЬНОЙ полуночи (симметрично
 * toIsoDate). `new Date('2026-07-01')` дал бы UTC-полночь, то есть на минусовых
 * смещениях — 30 июня в пикере. Мусор в параметре даёт null, а не Invalid Date.
 */
export function parseIsoDate(raw: string | null): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
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
  readonly label: Signal<string | null>;
  /** Выбран конкретный система/портфель — снимки стоимости их не различают */
  readonly segmented: Signal<boolean>;
  setSystem(id: string | null): void;
  setPortfolio(id: string | null): void;
  setPeriod(period: Period): void;
  setCustomFrom(date: Date | null): void;
  setCustomTill(date: Date | null): void;
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
  const range = computed(() => periodToRange(period(), new Date(), customFrom(), customTill()));

  return {
    system,
    portfolio,
    period,
    customFrom,
    customTill,
    range,
    label: computed(() => formatRangeLabel(range())),
    segmented: computed(() => system() !== null || portfolio() !== null),
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
  };
}
