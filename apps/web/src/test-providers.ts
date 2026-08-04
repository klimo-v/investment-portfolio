/**
 * Провайдеры тестового окружения приложения (`providersFile` билдера
 * `@angular/build:unit-test`). Сам TestBed инициализирует билдер — здесь только то,
 * что должно быть в каждом тесте.
 *
 * `provideZonelessChangeDetection()` обязателен: приложение zoneless (CLAUDE.md §4),
 * и тесты обязаны гонять ту же модель обнаружения изменений, иначе они зелёные на
 * поведении Zone.js, которого в рантайме нет.
 *
 * Роутер и HTTP — заглушки: почти всё, что тут тестируется, так или иначе читает
 * query-параметры (фильтры) или ресурсы. Настоящие запросы в юнит-тестах не нужны,
 * а `provideHttpClientTesting` заодно упадёт, если тест случайно сходит в сеть.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

export default [
  provideZonelessChangeDetection(),
  provideRouter([]),
  provideHttpClient(),
  provideHttpClientTesting(),
];
