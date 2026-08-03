/**
 * Цвета для Chart.js — единственный источник палитр графиков (раньше их было пять:
 * `C` и `LINE_PALETTE` в дашборде, `TYPE_COLOR` в портфеле и по набору у чипов
 * «Сделок» и «Импорта»).
 *
 * Почему TS-модуль, а не чтение var(--app-*) через getComputedStyle: Chart.js берёт
 * цвета как JS-значения. getComputedStyle резолвил бы light-dark() корректно, но это
 * императивное чтение layout'а — ничего не инвалидирует computed() при смене темы,
 * пришлось бы городить effect + ручной chart.update() против zoneless/OnPush-контракта
 * (CLAUDE.md §4). С обычной функцией от `dark` каждый чарт-computed() получает одну
 * зависимость theme.isDark() и пересобирается сам.
 */
import { Chart } from 'chart.js';

/**
 * Палитра линий/сегментов: столько различимых оттенков, сколько реально бывает
 * инструментов в портфеле. Индексируется по кругу (`i % length`).
 */
export const CHART_SERIES = [
  '#2a78d6',
  '#199e70',
  '#e0a400',
  '#8e5bd8',
  '#e34948',
  '#1baf7a',
  '#d6772a',
  '#5b8ad8',
  '#b0431f',
  '#3fa7b8',
  '#c85fa0',
  '#7a9e19',
  '#9e6b19',
  '#5f5fd8',
  '#d84f8e',
  '#4f9ed8',
] as const;

/** Цвет серии по индексу — по кругу, чтобы не выходить за границы палитры */
export function seriesColor(index: number): string {
  return CHART_SERIES[index % CHART_SERIES.length];
}

/** Смысловые цвета графиков: знак результата, опорные линии, итог */
export interface ChartSemantic {
  /** прибыль */
  positive: string;
  /** убыток */
  negative: string;
  /** нейтральный ряд (поток кэша, «внесено») */
  neutral: string;
  /** линия бенчмарка (IMOEX) */
  benchmark: string;
  /** линия вклада-ориентира */
  deposit: string;
  /** жирная линия «Итого» — максимальный контраст к фону, поэтому инвертируется */
  total: string;
}

export function chartSemantic(dark: boolean): ChartSemantic {
  return {
    positive: dark ? '#1baf7a' : '#199e70',
    negative: dark ? '#ef7b7a' : '#e34948',
    neutral: dark ? '#a8a7a0' : '#888780',
    benchmark: dark ? '#f0bd33' : '#e0a400',
    deposit: dark ? '#a8a7a0' : '#888780',
    total: dark ? '#f2f2f2' : '#111111',
  };
}

/**
 * Глобальные дефолты Chart.js под текущую тему. Без этого вызова библиотека остаётся
 * на своих значениях (текст #666, сетка rgba(0,0,0,0.1)) — на тёмном фоне подписи
 * осей, легенда и сетка становятся почти невидимыми, сколько бы токенов мы ни
 * навесили на сам CSS. Вызывается из effect'а ThemeService при каждой смене темы.
 */
export function applyChartDefaults(dark: boolean): void {
  Chart.defaults.color = dark ? 'rgba(255, 255, 255, 0.75)' : 'rgba(0, 0, 0, 0.65)';
  Chart.defaults.borderColor = dark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(0, 0, 0, 0.1)';
  Chart.defaults.font.family = "Roboto, 'Helvetica Neue', sans-serif";
}
