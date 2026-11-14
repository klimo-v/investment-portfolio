import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fromAppRoot, APP_ROOT } from '../app-paths';
import { LocalProfile } from './local-profile';
import {
  absolutePath,
  lockProfile,
  privateDirectory,
  ProfileError,
  readSettings,
  sourceFromProject,
  syncDirectory,
  syncFile,
} from './profile-files';

const Source = z.object({ source: z.string().min(1) }).strict();
const Project = z
  .object({
    projectRoot: z.string().min(1),
    dbPath: z.string().optional(),
    dataDir: z.string().optional(),
    envFile: z.string().optional(),
  })
  .strict();
const Token = z
  .object({
    sourceEnvFile: z.string().optional(),
    token: z.string().optional(),
    confirmation: z.literal('IMPORT TBANK_TOKEN'),
    replaceExisting: z.boolean().default(false),
  })
  .strict();

async function readInput(): Promise<unknown> {
  let text = '';
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 64 * 1024)
      throw new ProfileError('INVALID_INPUT', 'Слишком большой запрос мастера запуска.');
  }
  try {
    return JSON.parse(text || '{}') as unknown;
  } catch {
    throw new ProfileError('INVALID_INPUT', 'Ожидается JSON-запрос мастера запуска.');
  }
}
function transferToken(
  raw: unknown,
  file: string,
  tokenFromEnvironment: boolean,
): { configured: true; restartRequired: true } {
  const input = Token.parse(raw);
  if (Boolean(input.sourceEnvFile) === Boolean(input.token))
    throw new ProfileError('INVALID_INPUT', 'Выберите ровно один источник токена.');
  const token = input.token ?? readSettings(absolutePath(input.sourceEnvFile ?? ''))['TBANK_TOKEN'];
  if (!token || token.length > 8192 || !/^[A-Za-z0-9._:-]+$/.test(token))
    throw new ProfileError(
      'TOKEN_INVALID',
      'Выбранный источник не содержит допустимый токен T-Invest.',
    );
  if (process.env['TBANK_TOKEN']?.trim() && !input.replaceExisting)
    throw new ProfileError('TOKEN_EXISTS', 'Токен уже настроен. Подтвердите его замену отдельно.');
  if (tokenFromEnvironment)
    throw new ProfileError(
      'TOKEN_ENV_OVERRIDE',
      'Токен задан окружением запуска. Уберите TBANK_TOKEN из окружения и повторите перенос в файл настроек.',
    );
  const settingsDirectory = dirname(file);
  // ENV_FILE может лежать вне DATA_DIR; существующие права каталога не меняем.
  if (!existsSync(settingsDirectory)) privateDirectory(settingsDirectory);
  const staging = join(settingsDirectory, `.token-${randomUUID()}.tmp`);
  try {
    // Сохраняем остальные локальные настройки; из старого проекта переносится ТОЛЬКО TBANK_TOKEN.
    const content = existsSync(file)
      ? readFileSync(file, 'utf8').replace(/^\s*(?:export\s+)?TBANK_TOKEN\s*=.*$/gm, '')
      : '';
    writeFileSync(staging, `${content.trimEnd()}\nTBANK_TOKEN=${token}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    syncFile(staging);
    renameSync(staging, file);
    chmodSync(file, 0o600);
    syncDirectory(settingsDirectory);
  } finally {
    if (existsSync(staging)) unlinkSync(staging);
  }
  return { configured: true, restartRequired: true };
}

/** Единственная точка до импорта HTTP-графа и долгоживущего SQLite client.ts. */
export async function runEntry(): Promise<void> {
  const args = process.argv.slice(2);
  const cli = args[0] === 'profile';
  if (args.length && (!cli || args.length !== 2))
    throw new ProfileError('INVALID_ACTION', 'Используйте profile <действие>.');
  if (cli && !process.env['DATA_DIR'])
    process.env['DATA_DIR'] = join(
      homedir(),
      'Library',
      'Application Support',
      'Investment Portfolio',
    );
  const settings = await import('../load-env');
  const dataDir = resolve(process.env['DATA_DIR'] ?? fromAppRoot('data'));
  const dbPath = process.env['DATA_DIR']
    ? resolve(dataDir, process.env['DB_PATH'] ?? 'portfolio.sqlite')
    : fromAppRoot(process.env['DB_PATH'] ?? 'data/portfolio.sqlite');
  const migrationsFolder = join(__dirname, '../db/migrations');
  // В webpack __dirname — каталог main.js, assets лежат в ./migrations.
  const migrations = existsSync(migrationsFolder)
    ? migrationsFolder
    : join(__dirname, 'migrations');
  const profile = new LocalProfile({
    dataDir,
    dbPath,
    migrationsFolder: migrations,
    resources: process.env['APP_INSTALLED'] === '1' ? APP_ROOT : undefined,
  });
  const unlockDatabase = lockProfile(dbPath);
  let unlockSettings: () => void;
  try {
    unlockSettings = lockProfile(join(dataDir, '.profile-control'));
  } catch (error) {
    unlockDatabase();
    throw error;
  }
  const unlock = (): void => {
    unlockSettings();
    unlockDatabase();
  };
  let handedOff = false;
  try {
    profile.resume();
    if (cli) {
      const action = args[1];
      const input = ['status', 'init-empty', 'resolve-start'].includes(action)
        ? {}
        : await readInput();
      let result: unknown;
      switch (action) {
        case 'status':
          result = {
            ...profile.status(),
            tinvestConfigured: Boolean(process.env['TBANK_TOKEN']?.trim()),
          };
          break;
        case 'init-empty':
          result = await profile.initialise();
          break;
        case 'resolve-start':
          result = await profile.resolveStart();
          break;
        case 'inspect':
          result = await profile.inspect(absolutePath(Source.parse(input).source));
          break;
        case 'restore':
          result = await profile.initialise(absolutePath(Source.parse(input).source));
          break;
        case 'import-project':
          result = await profile.initialise(sourceFromProject(Project.parse(input)));
          break;
        case 'backup':
          await profile.export(
            absolutePath(z.object({ destination: z.string() }).strict().parse(input).destination),
          );
          result = { saved: true };
          break;
        case 'import-tinvest':
          result = transferToken(input, settings.settingsFile, settings.tokenFromEnvironment);
          break;
        case 'prepare-update':
          result = {
            backupDirectory: await profile.prepareUpdate(
              z.object({ previousApplication: z.string().optional() }).strict().parse(input)
                .previousApplication,
            ),
          };
          break;
        case 'recover-update': {
          const request = z
            .object({ directory: z.string(), confirmation: z.string() })
            .strict()
            .parse(input);
          result = await profile.recoverUpdate(request.directory, request.confirmation);
          break;
        }
        default:
          throw new ProfileError('INVALID_ACTION', 'Неизвестное действие мастера запуска.');
      }
      process.stdout.write(JSON.stringify({ ok: true, action, result }) + '\n');
      return;
    }
    if (!existsSync(dbPath) && process.env['APP_INSTALLED'] !== '1') await profile.initialise();
    await profile.beforeHttp();
    // require выполняется только здесь: sqlite/client ещё не открывал рабочий файл.
    const server = await import(/* webpackMode: "eager" */ '../http-server');
    await server.startHttp(unlock);
    handedOff = true;
  } finally {
    if (!handedOff) unlock();
  }
}

export function reportEntryError(error: unknown): void {
  const code =
    error instanceof ProfileError
      ? error.code
      : error instanceof z.ZodError
        ? 'INVALID_INPUT'
        : 'PROFILE_OPERATION_FAILED';
  const message =
    error instanceof ProfileError
      ? error.message
      : error instanceof z.ZodError
        ? 'Некорректный запрос. Проверьте выбранные параметры и повторите.'
        : 'Не удалось подготовить профиль. Рабочие данные сохранены. Проверьте файл, версию приложения, права доступа и свободное место, затем повторите.';
  // Никогда не выводим исходное исключение, stdin, env или содержимое настроек.
  process.stderr.write(JSON.stringify({ ok: false, error: { code, message } }) + '\n');
  process.exitCode = 1;
}
