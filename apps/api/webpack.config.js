const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

/**
 * Сборка NestJS через webpack (inferred-таргеты @nx/webpack/plugin).
 *
 * compiler: 'tsc' — критично: только TypeScript-компилятор эмитит
 * emitDecoratorMetadata, без которого не работает DI в NestJS
 * (@Injectable/@Controller и инъекция в конструктор). esbuild/swc-компиляторы
 * webpack-плагина этого не дают. См. docs/01-tech-stack.md.
 *
 * externals — опциональные зависимости NestJS, которые он подгружает лениво
 * только при использовании (микросервисы, websockets, express-адаптер,
 * class-validator и т.п.). Мы их не используем — не бандлим, резолвятся в
 * рантайме. Плюс нативный better-sqlite3.
 */
module.exports = {
  output: {
    path: join(__dirname, '../../dist/apps/api'),
  },
  externals: {
    '@nestjs/microservices': 'commonjs @nestjs/microservices',
    '@nestjs/microservices/microservices-module':
      'commonjs @nestjs/microservices/microservices-module',
    '@nestjs/websockets': 'commonjs @nestjs/websockets',
    '@nestjs/websockets/socket-module': 'commonjs @nestjs/websockets/socket-module',
    '@nestjs/platform-express': 'commonjs @nestjs/platform-express',
    'class-validator': 'commonjs class-validator',
    'class-transformer': 'commonjs class-transformer',
    'class-transformer/storage': 'commonjs class-transformer/storage',
    '@fastify/static': 'commonjs @fastify/static',
    '@fastify/view': 'commonjs @fastify/view',
    'better-sqlite3': 'commonjs better-sqlite3',
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: [],
      optimization: false,
      outputHashing: 'none',
      // generatePackageJson требует pnpm-lock.yaml и нужен только для деплоя;
      // для локального запуска отключено (см. README про production-сборку).
      generatePackageJson: false,
    }),
  ],
};
