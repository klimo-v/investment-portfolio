import { describe, it, expect } from 'vitest';
import { calendarDate } from './calendar';
import { PerformanceQuerySchema, SummaryQuerySchema, ValuationQuerySchema } from './schemas';

describe('календарь Mac и строгие диапазоны API', () => {
  it.each([
    ['2026-11-14T21:30:00Z', '2026-11-15'],
    ['2026-12-31T20:59:00Z', '2026-12-31'],
    ['2026-12-31T21:30:00Z', '2027-01-01'],
    ['2026-11-15T09:00:00Z', '2026-11-15'],
  ])('%s в Москве = %s', (instant, day) =>
    expect(calendarDate(new Date(instant), 'Europe/Moscow')).toBe(day),
  );
  it.each([SummaryQuerySchema, PerformanceQuerySchema, ValuationQuerySchema])(
    'отвергает несуществующие даты и обратные границы',
    (schema) => {
      for (const from of ['2026-02-31', '2026-02-29'])
        expect(schema.safeParse({ from }).success).toBe(false);
      expect(schema.safeParse({ from: '2026-03-02', till: '2026-03-01' }).success).toBe(false);
      expect(schema.safeParse({ from: '2024-02-29', till: '2024-02-29' }).success).toBe(true);
      expect(schema.safeParse({ till: '2026-11-15' }).success).toBe(true);
    },
  );
});
