#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
// tmp/ в .gitignore; файл перезаписывается при каждом запуске
const CA_BUNDLE = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR, 'tmp', 'extra-ca-certs.pem')
  : join(ROOT, 'tmp', 'extra-ca-certs.pem');

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error('Использование: node scripts/run-with-certs.mjs <команда> [аргументы]');
  process.exit(1);
}

/**
 * Значение NODE_EXTRA_CA_CERTS для дочернего процесса.
 *
 * Node принимает в переменной ровно один файл. Если она уже задана (например,
 * корневой сертификат корпоративного прокси), просто подменить её нельзя —
 * сломаются все исходящие HTTPS-запросы. Поэтому оба сертификата склеиваются
 * в один PEM-бандл.
 */
function resolveExtraCaCerts() {
  const existing = process.env.NODE_EXTRA_CA_CERTS;

  if (!existsSync(CERT)) {
    console.warn(
      `Сертификат не найден: ${CERT}\n` +
        'Приложение запустится, но импорт из T-Invest API будет падать на проверке TLS.',
    );
    return existing;
  }

  if (!existing || resolve(existing) === CERT) {
    return CERT;
  }

  try {
    const own = readFileSync(existing, 'utf8');
    // Один битый сертификат — и Node отбрасывает весь файл, вместе с нашим.
    assertValidPem(own);
    const bundle = `${own.trimEnd()}\n${readFileSync(CERT, 'utf8')}`;
    mkdirSync(dirname(CA_BUNDLE), { recursive: true });
    writeFileSync(CA_BUNDLE, bundle);
    return CA_BUNDLE;
  } catch (error) {
    // Нечитаемый или битый файл Node и сам проигнорировал бы с предупреждением —
    // результат тот же, что у одного нашего сертификата.
    console.warn(
      `Не удалось использовать NODE_EXTRA_CA_CERTS=${existing}: ${error.message}\n` +
        'Используется только сертификат Минцифры.',
    );
    return CERT;
  }
}

function assertValidPem(text) {
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks) {
    throw new Error('в файле нет PEM-сертификатов');
  }
  // Бросает на невалидном сертификате
  blocks.forEach((pem) => new X509Certificate(pem));
}

const env = { ...process.env };
const extraCaCerts = resolveExtraCaCerts();
if (extraCaCerts) {
  env.NODE_EXTRA_CA_CERTS = extraCaCerts;
}

// Для 'node' берётся текущий интерпретатор: в фоновом сервисе PATH урезанный
// и установленный через nvm/homebrew Node в нём может не значиться. Он
// запускается напрямую, без шелла, — путь вида C:\Program Files\... шелл
// разрезал бы по пробелу.
const isNode = command === 'node';
// nx и прочие бинарники на Windows — .cmd, их запускает только шелл.
const useShell = process.platform === 'win32' && !isNode;

const options = { cwd: ROOT, stdio: 'inherit', env };
const child = useShell
  ? // С shell: true Node склеивает аргументы через пробел без кавычек, а массив
    // аргументов вместе с шеллом объявлен устаревшим (DEP0190) — собираем
    // командную строку сами.
    spawn([command, ...args].map(quoteForCmd).join(' '), { ...options, shell: true })
  : spawn(isNode ? process.execPath : command, args, options);

function quoteForCmd(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

// Без пересылки сигнал завершает только обёртку, а запущенный процесс остаётся
// сиротой и держит порт: следующий запуск падает с EADDRINUSE. В Docker обёртка —
// PID 1, и без обработчика SIGTERM она его вообще проигнорирует.
const FORWARDED_SIGNALS = ['SIGTERM', 'SIGHUP'];
for (const signal of FORWARDED_SIGNALS) {
  process.on(signal, () => child.kill(signal));
}
// SIGINT (Ctrl+C) терминал шлёт всей группе процессов, и дочерний его уже
// получил — пересылка удвоила бы сигнал. Обёртке остаётся дождаться выхода
// дочернего процесса, а не умирать раньше него.
process.on('SIGINT', () => {});

child.on('error', (error) => {
  console.error(`Не удалось запустить «${command}»: ${error.message}`);
  process.exit(1);
});

// Код возврата пробрасываем как есть, иначе pnpm и launchd сочтут падение успехом.
child.on('exit', (code, signal) => {
  if (signal) {
    // Завершаемся тем же сигналом. Свои обработчики снимаем, иначе сигнал
    // поймали бы они же и процесс продолжил бы жить.
    for (const s of [...FORWARDED_SIGNALS, 'SIGINT']) {
      process.removeAllListeners(s);
    }
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
