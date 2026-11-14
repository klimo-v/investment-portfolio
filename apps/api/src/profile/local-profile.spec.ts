import Database from 'better-sqlite3';
import Decimal from 'decimal.js';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalProfile } from './local-profile';
import { hashFile, lockProfile, sourceFromProject } from './profile-files';
import { applyMigrations } from '../db/apply-migrations';
import { stateKey } from './profile-state';

// Настоящий запуск сохранённого runtime проверяется отдельной macOS-приёмкой.
vi.mock('./runtime-check', () => ({ validateRuntime: vi.fn(async () => undefined) }));

const full = join(__dirname, '../db/migrations');
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (cleanup.length) cleanup.pop()?.();
});
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'profile-2b-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function profile(dataDir = temporary(), migrationsFolder = full, resources?: string) {
  return new LocalProfile({
    dataDir,
    dbPath: join(dataDir, 'portfolio.sqlite'),
    migrationsFolder,
    resources,
  });
}
function older(root: string): string {
  const dir = join(root, 'old-migrations');
  cpSync(full, dir, { recursive: true });
  const journal = join(dir, 'meta/_journal.json');
  const value = JSON.parse(readFileSync(journal, 'utf8'));
  value.entries = value.entries.slice(0, 17);
  writeFileSync(journal, JSON.stringify(value));
  return dir;
}
function resource(root: string, migrations = full, label = 'current'): string {
  mkdirSync(join(root, 'server'), { recursive: true });
  mkdirSync(join(root, 'web'), { recursive: true });
  cpSync(migrations, join(root, 'server/migrations'), { recursive: true });
  for (const file of [
    'server/main.js',
    'web/index.html',
    'launch.mjs',
    'build-manifest.json',
    'start.sh',
  ])
    writeFileSync(join(root, file), label);
  return root;
}
function seed(file: string, migrations = full) {
  const db = new Database(file);
  db.pragma('journal_mode=WAL');
  db.pragma('wal_autocheckpoint=0');
  applyMigrations(db, migrations);
  db.exec(`INSERT INTO systems(id,name) VALUES ('s','System'); INSERT INTO portfolios(id,name) VALUES ('p','Account');
    INSERT INTO instruments(id,ticker,type,currency) VALUES ('i','TST','Stock','RUB');
    INSERT INTO operations(id,date,system_id,portfolio_id,instrument_id,operation_type,quantity,price,currency)
      VALUES ('op','2026-11-14','s','p','i','Buy','2','100','RUB');
    INSERT INTO quotes(instrument_id,price,currency,source,as_of) VALUES ('i','120','RUB','manual','2026-11-14');`);
  if (migrations !== full)
    db.exec(
      "INSERT INTO snapshot_positions(date,instrument_id,value_rub,quantity) VALUES('2026-11-13','i','220','2')",
    );
  return db;
}
function summary(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    const row = db
      .prepare(
        'SELECT o.quantity,q.price FROM operations o JOIN quotes q ON q.instrument_id=o.instrument_id',
      )
      .get() as { quantity: string; price: string };
    return {
      operations: (db.prepare('SELECT count(*) AS n FROM operations').get() as { n: number }).n,
      value: new Decimal(row.quantity).times(row.price).toFixed(2),
    };
  } finally {
    db.close();
  }
}

describe('первый запуск до открытия singleton SQLite', () => {
  it('объединяет два состояния сборки 3 для физически одного профиля без повторного отката', async () => {
    const dir = temporary();
    const data = join(dir, 'user');
    const alias = join(dir, 'alias');
    const resources = resource(join(dir, 'app'));
    const target = profile(data, full, resources);
    await target.initialise();
    symlinkSync(data, alias, 'dir');
    const pair = await target.prepareUpdate();
    const rolled = await target.recoverUpdate(pair, 'RESTORE UPDATE BACKUP');
    const canonicalState = join(data, '.profile', stateKey(target.options.dbPath));
    const legacyState = join(data, '.profile', stateKey(join(alias, 'portfolio.sqlite')));
    mkdirSync(legacyState);
    // В сборке 3 отметка оказалась только в состоянии другого написания пути.
    cpSync(
      join(canonicalState, 'required-release.json'),
      join(legacyState, 'required-release.json'),
    );
    rmSync(join(canonicalState, 'required-release.json'));
    const db = new Database(target.options.dbPath);
    db.exec("INSERT INTO portfolios(id,name) VALUES ('after-rollback','Keep current')");
    db.close();
    const before = hashFile(target.options.dbPath);
    rmSync(join(pair, 'portfolio.sqlite'));
    for (const path of [alias, data, alias, data]) {
      const reopened = profile(path, full, resources);
      reopened.resume();
      expect(await reopened.resolveStart()).toEqual({
        launchPath: realpathSync(rolled.launchPath),
      });
      expect(hashFile(reopened.options.dbPath)).toBe(before);
    }
    expect(realpathSync(legacyState)).toBe(realpathSync(canonicalState));
  });
  it('противоречивые отметки и pending двух написаний останавливаются до изменения базы', async () => {
    const dir = temporary();
    const data = join(dir, 'user');
    const alias = join(dir, 'alias');
    const target = profile(data);
    await target.initialise();
    symlinkSync(data, alias, 'dir');
    const states = [data, alias].map((path) =>
      join(data, '.profile', stateKey(join(path, 'portfolio.sqlite'))),
    );
    for (const [index, state] of states.entries()) {
      mkdirSync(state, { recursive: true });
      writeFileSync(
        join(state, 'required-release.json'),
        JSON.stringify({ id: String(index), launchPath: join(data, 'backups/start.sh') }),
      );
    }
    const before = hashFile(target.options.dbPath);
    expect(() => profile(alias).resume()).toThrow(
      expect.objectContaining({ code: 'PROFILE_STATE_CONFLICT' }),
    );
    expect(hashFile(target.options.dbPath)).toBe(before);
    for (const [index, state] of states.entries()) {
      rmSync(join(state, 'required-release.json'));
      writeFileSync(
        join(state, 'pending.json'),
        JSON.stringify({
          stage: join(data, 'stage/portfolio.sqlite'),
          digest: String(index),
          previousDigest: before,
          requiredRelease: null,
        }),
      );
    }
    expect(() => profile(alias).resume()).toThrow(
      expect.objectContaining({ code: 'PROFILE_STATE_CONFLICT' }),
    );
    expect(hashFile(target.options.dbPath)).toBe(before);
  });
  it('явный пустой старт; существующий профиль не перезаписывается; неверный путь не создаёт БД', async () => {
    const target = profile();
    target.resume();
    await expect(target.beforeHttp()).rejects.toMatchObject({ code: 'ONBOARDING_REQUIRED' });
    await expect(target.initialise(join(temporary(), 'missing.sqlite'))).rejects.toMatchObject({
      code: 'SOURCE_UNREADABLE',
    });
    expect(existsSync(target.options.dbPath)).toBe(false);
    const invalid = join(temporary(), 'broken.sqlite');
    writeFileSync(invalid, 'broken');
    await expect(target.initialise(invalid)).rejects.toThrow();
    expect(existsSync(target.options.dbPath)).toBe(false);
    expect(await target.initialise()).toMatchObject({ accounts: 0, operations: 0 });
    const before = hashFile(target.options.dbPath);
    await expect(target.initialise()).rejects.toMatchObject({ code: 'PROFILE_EXISTS' });
    expect(hashFile(target.options.dbPath)).toBe(before);
    expect(statSync(target.options.dbPath).mode & 0o777).toBe(0o600);
  });
  it('согласованный перенос WAL, неизменность источника, работа после удаления исходника', async () => {
    const source = join(temporary(), 'original.sqlite');
    const db = seed(source);
    cleanup.push(() => {
      if (db.open) db.close();
    });
    expect(statSync(source + '-wal').size).toBeGreaterThan(0);
    const before = hashFile(source);
    const target = profile();
    target.resume();
    const result = await target.initialise(source);
    expect(result).toMatchObject({ accounts: 1, operations: 1 });
    expect(hashFile(source)).toBe(before);
    expect(summary(target.options.dbPath)).toEqual({ operations: 1, value: '240.00' });
    db.close();
    rmSync(source);
    await target.beforeHttp();
    expect(summary(target.options.dbPath).value).toBe('240.00');
  });
  it('миграции старой базы выполняются только на копии, включая перенос снимков между стадиями', async () => {
    const dir = temporary();
    const migrations = older(dir);
    const source = join(dir, 'old.sqlite');
    const old = seed(source, migrations);
    old.close();
    const before = hashFile(source);
    const target = profile();
    target.resume();
    await target.initialise(source);
    expect(hashFile(source)).toBe(before);
    const db = new Database(target.options.dbPath);
    try {
      expect(
        db
          .prepare("SELECT price FROM price_history WHERE instrument_id='i' AND date='2026-11-13'")
          .get(),
      ).toEqual({ price: '110' });
    } finally {
      db.close();
    }
  });
  it('сбой миграции не создаёт пустой профиль; повтор с исправленным комплектом миграций успешен', async () => {
    const dir = temporary();
    const oldMigrations = older(dir);
    const source = join(dir, 'old.sqlite');
    const old = seed(source, oldMigrations);
    old.close();
    const broken = join(dir, 'broken-migrations');
    cpSync(full, broken, { recursive: true });
    const journal = JSON.parse(readFileSync(join(broken, 'meta/_journal.json'), 'utf8'));
    const last = journal.entries.at(-1);
    writeFileSync(join(broken, last.tag + '.sql'), 'INVALID MIGRATION SQL');
    const target = profile(temporary(), broken);
    target.resume();
    await expect(target.initialise(source)).rejects.toThrow();
    expect(existsSync(target.options.dbPath)).toBe(false);
    const retry = profile(target.options.dataDir);
    retry.resume();
    await retry.initialise(source);
    expect(summary(retry.options.dbPath).operations).toBe(1);
  });
  it('прерывание после подготовки: повтор завершает публикацию без исходного файла', async () => {
    const source = join(temporary(), 'source.sqlite');
    const db = seed(source);
    db.close();
    const target = profile();
    target.resume();
    vi.spyOn(target, 'resume').mockImplementationOnce(() => {
      throw new Error('interrupted before publication');
    });
    await expect(target.initialise(source)).rejects.toThrow('interrupted');
    expect(existsSync(target.options.dbPath)).toBe(false);
    rmSync(source);
    const retry = profile(target.options.dataDir);
    retry.resume();
    expect(summary(retry.options.dbPath).operations).toBe(1);
  });
  it('путь старого проекта учитывает DB_PATH и DATA_DIR, окружение получателя не используется', () => {
    const root = temporary();
    writeFileSync(
      join(root, '.env'),
      'DB_PATH="old files/book.sqlite"\nPORT=9999\nTBANK_TOKEN=not-to-copy\n',
    );
    expect(sourceFromProject({ projectRoot: root })).toBe(join(root, 'old files/book.sqlite'));
    writeFileSync(join(root, '.env'), 'DATA_DIR="Local Data"\nDB_PATH=book.sqlite\n');
    expect(sourceFromProject({ projectRoot: root })).toBe(join(root, 'Local Data/book.sqlite'));
    expect(sourceFromProject({ projectRoot: root, dbPath: '/tmp/external.sqlite' })).toBe(
      '/tmp/external.sqlite',
    );
  });
  it('эксклюзивная блокировка общая для HTTP и команд профиля', () => {
    const target = profile();
    const release = lockProfile(target.options.dbPath);
    expect(() => lockProfile(target.options.dbPath)).toThrow(/используется/);
    release();
    lockProfile(target.options.dbPath)();
  });
});

describe('копия перед обновлением и совместимая пара', () => {
  it('повторный запуск после отката выбирает сервер с текущей БД, даже без файла снимка', async () => {
    const dir = temporary();
    const resources = resource(join(dir, 'app'));
    const target = profile(join(dir, 'data'), full, resources);
    await target.initialise();
    expect(await target.resolveStart()).toEqual({ launchPath: null });
    const pair = await target.prepareUpdate();
    const rolled = await target.recoverUpdate(pair, 'RESTORE UPDATE BACKUP');
    const db = new Database(target.options.dbPath);
    db.exec("INSERT INTO systems(id,name) VALUES ('after-rollback','Keep current data')");
    db.close();
    rmSync(join(pair, 'portfolio.sqlite'));
    const before = hashFile(target.options.dbPath);
    expect(await target.resolveStart()).toEqual({ launchPath: realpathSync(rolled.launchPath) });
    expect(hashFile(target.options.dbPath)).toBe(before);
    const check = new Database(target.options.dbPath);
    try {
      expect(check.prepare("SELECT name FROM systems WHERE id='after-rollback'").get()).toEqual({
        name: 'Keep current data',
      });
    } finally {
      check.close();
    }
    rmSync(rolled.launchPath);
    await expect(target.resolveStart()).rejects.toMatchObject({
      code: 'RECOVERY_APPLICATION_REQUIRED',
    });
    expect(hashFile(target.options.dbPath)).toBe(before);
  });
  it('автоматическая копия до нескольких стадий миграций; откат пары с сохранением новой базы', async () => {
    const dir = temporary();
    const oldMigrations = older(dir);
    const oldResources = resource(join(dir, 'Old Resources'), oldMigrations, 'old');
    const currentResources = resource(join(dir, 'New Resources'), full, 'new');
    const data = join(dir, 'User Data');
    mkdirSync(data);
    const source = seed(join(data, 'portfolio.sqlite'), oldMigrations);
    source.close();
    const old = profile(data, oldMigrations, oldResources);
    old.resume();
    await old.beforeHttp();
    const newer = profile(data, full, currentResources);
    newer.resume();
    await newer.beforeHttp();
    expect(summary(newer.options.dbPath)).toEqual({ operations: 1, value: '240.00' });
    const pairs = readdirSync(join(data, 'backups')).filter((x) => x.startsWith('update-'));
    expect(pairs).toHaveLength(1);
    const pair = join(data, 'backups', pairs[0]);
    const premigration = new Database(join(pair, 'portfolio.sqlite'), { readonly: true });
    try {
      expect(premigration.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
        n: 17,
      });
      expect(premigration.prepare('SELECT * FROM snapshot_positions').all()).toHaveLength(1);
    } finally {
      premigration.close();
    }
    const rolled = await newer.recoverUpdate(pair, 'RESTORE UPDATE BACKUP');
    expect(existsSync(rolled.launchPath)).toBe(true);
    expect(existsSync(join(rolled.safetyBackup, 'portfolio.sqlite'))).toBe(true);
    await expect(newer.beforeHttp()).rejects.toMatchObject({
      code: 'RECOVERY_APPLICATION_REQUIRED',
    });
    const recovered = profile(data, oldMigrations, join(pair, 'application'));
    recovered.resume();
    await recovered.beforeHttp();
    const db = new Database(recovered.options.dbPath);
    try {
      expect(db.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({ n: 17 });
    } finally {
      db.close();
    }
    const restart = await recovered.prepareUpdate();
    expect(existsSync(restart)).toBe(true);
    await newer.beforeHttp();
    expect(summary(newer.options.dbPath).value).toBe('240.00');
  });
  it('ошибка будущей миграции сохраняет исходную базу и предмиграционную пару', async () => {
    const dir = temporary();
    const oldMigrations = older(dir);
    const resources = resource(join(dir, 'old-app'), oldMigrations);
    const target = profile(join(dir, 'user'), oldMigrations, resources);
    mkdirSync(target.options.dataDir);
    const old = seed(target.options.dbPath, oldMigrations);
    old.close();
    target.resume();
    await target.beforeHttp();
    const before = hashFile(target.options.dbPath);
    const broken = join(dir, 'bad');
    cpSync(full, broken, { recursive: true });
    writeFileSync(join(broken, '0022_operation_source_code.sql'), 'INVALID MIGRATION');
    const upgraded = profile(
      target.options.dataDir,
      broken,
      resource(join(dir, 'new-app'), broken, 'bad'),
    );
    await expect(upgraded.beforeHttp()).rejects.toThrow();
    expect(hashFile(target.options.dbPath)).toBe(before);
    expect(
      readdirSync(join(target.options.dataDir, 'backups')).filter((x) => x.startsWith('update-')),
    ).toHaveLength(1);
    const pair = readdirSync(join(target.options.dataDir, 'backups')).find((x) =>
      x.startsWith('update-'),
    )!;
    const recovered = await upgraded.recoverUpdate(
      join(target.options.dataDir, 'backups', pair),
      'RESTORE UPDATE BACKUP',
    );
    expect(existsSync(recovered.launchPath)).toBe(true);
    expect(summary(target.options.dbPath).operations).toBe(1);
  });
  it('неполный runtime отклоняется до замены базы, новая запись сохраняется', async () => {
    const dir = temporary();
    const resources = resource(join(dir, 'app'));
    const target = profile(join(dir, 'data'), full, resources);
    await target.initialise();
    const pair = await target.prepareUpdate();
    const db = new Database(target.options.dbPath);
    db.exec("INSERT INTO systems(id,name) VALUES ('new','Keep me')");
    db.close();
    rmSync(join(pair, 'application/start.sh'));
    await expect(target.recoverUpdate(pair, 'RESTORE UPDATE BACKUP')).rejects.toMatchObject({
      code: 'RECOVERY_DAMAGED',
    });
    const current = new Database(target.options.dbPath);
    try {
      expect(current.prepare("SELECT name FROM systems WHERE id='new'").get()).toEqual({
        name: 'Keep me',
      });
    } finally {
      current.close();
    }
  });
});
