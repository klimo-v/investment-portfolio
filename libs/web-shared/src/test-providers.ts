/**
 * Провайдеры тестового окружения UI-кита (`providersFile` билдера
 * `@angular/build:unit-test`). Сам TestBed инициализирует билдер — здесь только то,
 * что должно быть в каждом тесте.
 *
 * `provideZonelessChangeDetection()` обязателен: приложение zoneless (CLAUDE.md §4),
 * и тесты обязаны гонять ту же модель обнаружения изменений, иначе они зелёные на
 * поведении Zone.js, которого в рантайме нет.
 */
import { provideZonelessChangeDetection } from '@angular/core';

export default [provideZonelessChangeDetection()];
