import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { StrictDateAdapter } from './strict-date-adapter';
import { rangeError, toIsoDate } from './dashboard-filter.state';

describe('ручной ввод календарных дат', () => {
  it('не позволяет NativeDateAdapter нормализовать февраль в март', () => {
    const adapter = TestBed.runInInjectionContext(() => new StrictDateAdapter());
    for (const raw of ['31.02.2026', '29.02.2026', '2026-02-31'])
      expect(adapter.isValid(adapter.parse(raw)!)).toBe(false);
    for (const raw of ['29.02.2024', '2024-02-29'])
      expect(toIsoDate(adapter.parse(raw)!)).toBe('2024-02-29');
    expect(adapter.parse('')).toBeNull();
    expect(rangeError('2026-02-', null)).toBeNull();
    expect(rangeError('2026-02-31', null)).toContain('несуществующая');
  });
});
