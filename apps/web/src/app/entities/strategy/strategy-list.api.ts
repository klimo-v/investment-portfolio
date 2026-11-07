import { Injectable, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import type { StrategySummary } from '@core';

/**
 * Проверка формы ответа списка стратегий — вручную, без Zod. Корневой компонент лежит в
 * initial-бандле, а полный импорт `zod` добавлял туда ~330 кБ (проверено сборкой при бюджете
 * initial 800 кБ: 1.09 МБ против 0.71 МБ). Тип `StrategySummary` из `@core` — контракт:
 * возвращаемый тип проверяется компилятором. Схемы остальных ответов стратегии — в
 * `strategy.api.ts`, он грузится лениво вместе со страницей.
 */
export function parseStrategies(raw: unknown): StrategySummary[] {
  if (!Array.isArray(raw)) throw new Error('Список стратегий: ожидался массив');
  return raw.map((item: unknown): StrategySummary => {
    const o = item as Record<string, unknown> | null;
    const nullableString = (v: unknown): string | null => {
      if (v === null || typeof v === 'string') return v;
      throw new Error('Список стратегий: поле портфеля должно быть строкой или null');
    };
    if (
      !o ||
      typeof o['systemId'] !== 'string' ||
      typeof o['name'] !== 'string' ||
      o['adapter'] !== 'quik-bridge'
    ) {
      throw new Error('Список стратегий: неверная строка');
    }
    return {
      systemId: o['systemId'],
      name: o['name'],
      adapter: o['adapter'],
      portfolioId: nullableString(o['portfolioId']),
      portfolioName: nullableString(o['portfolioName']),
    };
  });
}

/**
 * Список настроенных стратегий — для бокового меню и заголовков страницы стратегии.
 * Меняется только при создании и удалении стратегии, поэтому перезапрашивается по своему
 * триггеру `reload()`, а не по общему DataRevision (его двигает любая мутация в приложении).
 */
@Injectable({ providedIn: 'root' })
export class StrategyListApi {
  private readonly reloadTrigger = signal(0);

  readonly list = httpResource(
    () => {
      this.reloadTrigger();
      return '/api/strategies';
    },
    { parse: parseStrategies },
  );

  /** Перезапросить список после создания/удаления стратегии */
  reload(): void {
    this.reloadTrigger.update((n) => n + 1);
  }
}
