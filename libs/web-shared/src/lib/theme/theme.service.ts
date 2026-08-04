import { computed, effect, Injectable, signal } from '@angular/core';
import { applyChartDefaults } from './chart-tokens';
import { mediaQuery } from './media-query';

/** Режим темы: явный выбор пользователя либо «как в системе» */
export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'app-theme';
const MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

function isThemeMode(value: string | null): value is ThemeMode {
  return value !== null && (MODES as readonly string[]).includes(value);
}

/** Читаем синхронно при создании сервиса, чтобы не мигать светлой темой на старте */
function readStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemeMode(stored) ? stored : 'system';
  } catch {
    // localStorage недоступен (приватный режим, отключённые куки) — не повод падать
    return 'system';
  }
}

/**
 * Переключение светлой/тёмной темы (docs/05-review-usability.md).
 *
 * Механизм — ОДНО CSS-свойство `color-scheme` на <html>, а не класс `.dark-theme` и
 * не повторный вызов mat.theme() с theme-type: dark. Причина: `mat.theme()` в
 * styles.scss не получает `theme-type`, поэтому Material по умолчанию собирает тему
 * в режиме `color-scheme` и выдаёт ВСЕ свои токены как `light-dark(светлый, тёмный)`.
 * Такое значение читает сам браузер, ориентируясь на `color-scheme` элемента — то
 * есть достаточно переписать одно свойство, и разом переключаются и --mat-sys-*, и
 * наши --app-* (они тоже объявлены через light-dark()).
 *
 * Три режима, а не два: двухпозиционный переключатель молча выбрасывает
 * `prefers-color-scheme`, а это то, чего пользователь чаще всего и хочет.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly prefersDark = mediaQuery('(prefers-color-scheme: dark)');
  private readonly modeState = signal<ThemeMode>(readStoredMode());

  /** Выбранный режим (включая 'system') — для подсветки переключателя */
  readonly mode = this.modeState.asReadonly();

  /**
   * Тёмная ли тема ФАКТИЧЕСКИ сейчас. Именно от этого сигнала зависят чарт-computed():
   * Chart.js берёт цвета JS-значениями и через CSS-токены их не достать.
   */
  readonly isDark = computed(() =>
    this.modeState() === 'system' ? this.prefersDark() : this.modeState() === 'dark',
  );

  constructor() {
    effect(() => {
      const mode = this.modeState();
      // 'light dark' = «решает система»: браузер сам выберет ветку в light-dark()
      document.documentElement.style.colorScheme = mode === 'system' ? 'light dark' : mode;
      try {
        localStorage.setItem(STORAGE_KEY, mode);
      } catch {
        // запись недоступна — тема просто не переживёт перезагрузку
      }
    });

    // Дефолты Chart.js (цвет подписей, сетка) живут в JS и на CSS-токены не реагируют:
    // без этого в тёмной теме оси, легенда и сетка почти невидимы
    effect(() => applyChartDefaults(this.isDark()));
  }

  set(mode: ThemeMode): void {
    this.modeState.set(mode);
  }

  /** Следующий режим по кругу: светлая → тёмная → системная */
  cycle(): void {
    const next = (MODES.indexOf(this.modeState()) + 1) % MODES.length;
    this.modeState.set(MODES[next]);
  }
}
