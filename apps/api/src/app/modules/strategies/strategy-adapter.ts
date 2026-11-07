import type { Yv1Overview } from '@core';
import type { Yv1RefreshReport, Yv1SettingsPatch, Yv1SettingsState } from '../yv1/yv1.store';

/**
 * Контракт адаптера источника стратегии (DIP, OCP — CLAUDE.md §7): сервис и контроллер
 * работают с ним, а не с конкретным форматом файлов. Новый источник (спот, другой автомат)
 * = новая реализация + строка в реестре `createStrategyAdapter`.
 *
 * Типы обзора и отчёта пока общие с мостом QUIK: пока адаптер один, выдумывать для них
 * отдельную абстракцию рано — она появится вместе со вторым адаптером.
 */
/**
 * Нейтральные имена типов контракта. Сейчас они совпадают с формами моста QUIK (единственный
 * адаптер); когда появится второй (спот и т.п.), расходящиеся формы заводятся здесь, а
 * сервис и контроллер, импортирующие только эти имена, не меняются.
 */
export type StrategyOverview = Yv1Overview;
export type StrategyRefreshReport = Yv1RefreshReport;
export type StrategySettings = Yv1SettingsState;
export type StrategySettingsPatch = Yv1SettingsPatch;

export interface StrategyAdapter {
  /** Прочитать источник в БД (идемпотентно) и пересобрать ленту результата для портфеля */
  refresh(): StrategyRefreshReport;
  /** Всё для страницы стратегии */
  overview(): StrategyOverview;
  /** Фактическая кривая `date,ret,equity`; ошибка, если посчитать нельзя */
  curveCsv(): string;
  getSettings(): StrategySettings;
  updateSettings(patch: StrategySettingsPatch): StrategySettings;
  /** Привязать счёт стратегии к портфелю */
  linkPortfolio(portfolioId: string): void;
}
