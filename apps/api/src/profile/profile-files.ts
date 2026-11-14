import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

export class ProfileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function absolutePath(path: string): string {
  if (!isAbsolute(path))
    throw new ProfileError('INVALID_PATH', 'Выберите полный путь к файлу или каталогу.');
  return path;
}
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
export function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function syncFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function atomicJson(path: string, value: unknown): void {
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    syncFile(staging);
    renameSync(staging, path);
    syncDirectory(dirname(path));
  } finally {
    if (existsSync(staging)) unlinkSync(staging);
  }
}
export function hashFile(path: string): string {
  const fd = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let length: number;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}
export function readSettings(file: string, optional = false): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(file, 'utf8'));
  } catch {
    if (optional && !existsSync(file)) return {};
    throw new ProfileError('SETTINGS_UNREADABLE', 'Не удалось прочитать выбранный файл настроек.');
  }
}

/** SQLite-lock освобождается ядром и после SIGKILL; PID/устаревшие lock-файлы не нужны. */
export function lockProfile(dbPath: string): () => void {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const path = `${dbPath}.profile-lock`;
  const lock = new Database(path, { timeout: 0 });
  try {
    chmodSync(path, 0o600);
    lock.exec('BEGIN EXCLUSIVE');
  } catch {
    lock.close();
    throw new ProfileError(
      'PROFILE_BUSY',
      'Профиль уже используется. Закройте приложение и повторите.',
    );
  }
  return () => {
    if (lock.open) lock.close();
  };
}

export function sourceFromProject(input: {
  projectRoot: string;
  dbPath?: string;
  dataDir?: string;
  envFile?: string;
}): string {
  const root = absolutePath(input.projectRoot);
  const settings = readSettings(input.envFile ?? join(root, '.env'), !input.envFile);
  // Не переносим окружение и настройки старого проекта в процесс нового приложения.
  const dataDir = input.dataDir ?? settings['DATA_DIR'];
  const base = dataDir ? resolve(root, dataDir) : root;
  return resolve(
    base,
    input.dbPath ?? settings['DB_PATH'] ?? (dataDir ? 'portfolio.sqlite' : 'data/portfolio.sqlite'),
  );
}
