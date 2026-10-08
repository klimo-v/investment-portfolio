#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Запуск команды с корректным окружением: рабочий каталог — корень проекта,
 * NODE_EXTRA_CA_CERTS — абсолютный путь к корневому сертификату Минцифры
 * (нужен для T-Invest API, см. certs/README.md).
 *
 * Зачем отдельный скрипт вместо префикса в package.json:
 *   - переменную нельзя положить в .env — Node читает её при старте процесса,
 *     раньше, чем приложение успевает загрузить файл;
 *   - относительный путь `certs/...` находился только при запуске из корня,
 *     а фоновому сервису и ярлыку рабочий каталог не навяжешь;
 *   - синтаксис `VAR=значение команда` не работает в cmd.exe.
 *
 * Использование:
 *   node scripts/run-with-certs.mjs node dist/apps/api/main.js
 *   node scripts/run-with-certs.mjs nx serve api
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CERT = join(ROOT, 'certs', 'russian_trusted_root_ca.pem');

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error('Использование: node scripts/run-with-certs.mjs <команда> [аргументы]');
  process.exit(1);
}

const env = { ...process.env };

if (existsSync(CERT)) {
  env.NODE_EXTRA_CA_CERTS = CERT;
} else {
  console.warn(
    `Сертификат не найден: ${CERT}\n` +
      'Приложение запустится, но импорт из T-Invest API будет падать на проверке TLS.',
  );
}

// Для 'node' берётся текущий интерпретатор: в фоновом сервисе PATH урезанный
// и установленный через nvm/homebrew Node в нём может не значиться.
const bin = command === 'node' ? process.execPath : command;

const child = spawn(bin, args, {
  cwd: ROOT,
  stdio: 'inherit',
  // nx и прочие бинарники на Windows — .cmd, их запускает только шелл.
  shell: process.platform === 'win32',
  env,
});

child.on('error', (error) => {
  console.error(`Не удалось запустить «${command}»: ${error.message}`);
  process.exit(1);
});

// Код возврата пробрасываем как есть, иначе pnpm и launchd сочтут падение успехом.
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
