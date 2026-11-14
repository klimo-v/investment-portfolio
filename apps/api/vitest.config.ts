import { defineConfig } from 'vitest/config';

/**
 * Юнит-тесты бэкенда (CLAUDE.md §10). Нужны для кода, который не может жить в
 * `libs/core` из-за Node-зависимостей: работа с базой данных и
 * оркестрация синхронизации с T-Invest API.
 *
 * `@core` резолвим вручную — vitest не читает пути из tsconfig.base.json.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
  resolve: {
    alias: { '@core': new URL('../../libs/core/src/index.ts', import.meta.url).pathname },
  },
});
