import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme.service';

/**
 * Тесты переключения темы. Проверяют ровно то, что легко сломать: что режим
 * переживает перезагрузку, что 'system' действительно следует за ОС (а не
 * прикидывается светлым) и что применяется именно color-scheme на <html> — на нём
 * держится вся тёмная тема, потому что и --mat-sys-*, и --app-* объявлены через
 * light-dark().
 */

/** Подменяет prefers-color-scheme: в jsdom matchMedia либо нет, либо он всегда false */
function mockPrefersDark(dark: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('prefers-color-scheme: dark') ? dark : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.colorScheme = '';
    mockPrefersDark(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('по умолчанию — системный режим, color-scheme отдан браузеру', () => {
    const service = TestBed.inject(ThemeService);
    TestBed.tick();

    expect(service.mode()).toBe('system');
    expect(document.documentElement.style.colorScheme).toBe('light dark');
  });

  it('явный выбор проставляет color-scheme и сохраняется в localStorage', () => {
    const service = TestBed.inject(ThemeService);
    service.set('dark');
    TestBed.tick();

    expect(service.isDark()).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(localStorage.getItem('app-theme')).toBe('dark');
  });

  it('сохранённый режим переживает пересоздание сервиса (перезагрузку страницы)', () => {
    localStorage.setItem('app-theme', 'light');

    const service = TestBed.inject(ThemeService);
    expect(service.mode()).toBe('light');
    expect(service.isDark()).toBe(false);
  });

  it('режим system следует за системной тёмной темой', () => {
    mockPrefersDark(true);

    const service = TestBed.inject(ThemeService);
    expect(service.mode()).toBe('system');
    expect(service.isDark()).toBe(true);
  });

  it('явный светлый режим НЕ подчиняется системной тёмной теме', () => {
    mockPrefersDark(true);

    const service = TestBed.inject(ThemeService);
    service.set('light');

    expect(service.isDark()).toBe(false);
  });

  it('cycle() идёт по кругу светлая → тёмная → системная', () => {
    const service = TestBed.inject(ThemeService);
    service.set('light');

    service.cycle();
    expect(service.mode()).toBe('dark');
    service.cycle();
    expect(service.mode()).toBe('system');
    service.cycle();
    expect(service.mode()).toBe('light');
  });

  it('мусор в localStorage не роняет сервис, откатывает на системный режим', () => {
    localStorage.setItem('app-theme', 'neon');

    const service = TestBed.inject(ThemeService);
    expect(service.mode()).toBe('system');
  });
});
