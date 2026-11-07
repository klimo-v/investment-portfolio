import { describe, expect, it } from 'vitest';
import { StrategySummarySchema } from '@core';
import { parseStrategies } from './strategy-list.api';

/**
 * Ручной парсер списка (без Zod — ради бюджета initial-бандла) не должен разъехаться с
 * контрактом: на одних и тех же входах он принимает и отклоняет то же, что схема из @core.
 */
describe('parseStrategies ↔ StrategySummarySchema', () => {
  const ok = { systemId: 's1', name: 'ЮВ1', adapter: 'quik-bridge', portfolioId: 'p1', portfolioName: 'Trader' };
  const cases: Record<string, unknown> = {
    'полная строка': ok,
    'портфель не привязан': { ...ok, portfolioId: null, portfolioName: null },
    'нет systemId': { ...ok, systemId: undefined },
    'systemId не строка': { ...ok, systemId: 1 },
    'нет name': { ...ok, name: undefined },
    'неизвестный адаптер': { ...ok, adapter: 'spot-x' },
    'portfolioId — число': { ...ok, portfolioId: 5 },
    'не объект': 'строка',
    null: null,
  };

  for (const [name, row] of Object.entries(cases)) {
    it(`${name}: решение совпадает со схемой`, () => {
      const schema = StrategySummarySchema.safeParse(row).success;
      let manual = true;
      try {
        parseStrategies([row]);
      } catch {
        manual = false;
      }
      expect(manual).toBe(schema);
    });
  }

  it('успешный разбор возвращает те же значения, что схема', () => {
    expect(parseStrategies([ok])).toEqual([StrategySummarySchema.parse(ok)]);
  });

  it('не массив — ошибка', () => {
    expect(() => parseStrategies({})).toThrow();
  });
});
