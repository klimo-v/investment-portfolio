import Database from 'better-sqlite3';
import Decimal from 'decimal.js';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, statSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './apply-migrations';
import { PortfolioBackup } from './portfolio-backup';

const migrations = join(__dirname, 'migrations');
const backups = new PortfolioBackup(migrations);
const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});
function profile() {
  const directory = mkdtempSync(join(tmpdir(), 'portfolio-test-'));
  cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
  const file = join(directory, 'portfolio.sqlite');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('wal_autocheckpoint = 0');
  applyMigrations(db, migrations);
  cleanup.push(() => {
    if (db.open) db.close();
  });
  return { directory, file, db };
}
function seed(db: Database.Database, id = 'A') {
  db.exec(`INSERT INTO systems(id,name) VALUES ('${id}','System ${id}');
    INSERT INTO portfolios(id,name) VALUES ('${id}','Account ${id}');
    INSERT INTO instruments(id,ticker,type,currency) VALUES ('${id}','${id}','Stock','RUB');
    INSERT INTO operations(id,date,system_id,portfolio_id,instrument_id,operation_type,quantity,price,currency)
      VALUES ('${id}','2026-11-14','${id}','${id}','${id}','Buy','2','100','RUB');
    INSERT INTO quotes(instrument_id,price,currency,source,as_of) VALUES ('${id}','120','RUB','manual','2026-11-14');`);
  if (!db.inTransaction) applyMigrations(db, migrations);
}
function dump(db: Database.Database) {
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return names.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]);
}

describe('автономная SQLite-копия и атомарная замена', () => {
  it('WAL → единственный файл → чистый Б и заполненный профиль; клиент остаётся актуальным; рестарт', async () => {
    const a = profile();
    seed(a.db);
    expect(statSync(`${a.file}-wal`).size).toBeGreaterThan(0);
    const snapshot = join(a.directory, 'download.sqlite');
    await backups.backup(a.db, snapshot);
    const b = profile();
    const transferred = join(b.directory, 'only-file.sqlite');
    cpSync(snapshot, transferred);
    expect(backups.prepare(transferred)).toEqual({ accounts: 1, operations: 1, systems: 1 });
    const query = b.db.prepare('SELECT id FROM operations');
    backups.replace(b.db, transferred);
    expect(dump(b.db)).toEqual(dump(a.db));
    expect(query.all()).toEqual([{ id: 'A' }]);
    // При одинаковых котировках количество * цена = тот же итог 240 RUB.
    const position = b.db
      .prepare(
        'SELECT quantity, q.price FROM operations o JOIN quotes q ON q.instrument_id=o.instrument_id',
      )
      .get() as { quantity: string; price: string };
    expect(new Decimal(position.quantity).times(position.price).toFixed(2)).toBe('240.00');
    seed(b.db, 'B');
    backups.replace(b.db, transferred);
    expect(dump(b.db)).toEqual(dump(a.db));
    b.db.prepare("INSERT INTO systems(id,name) VALUES ('NEW','After restore')").run();
    b.db.close();
    const restarted = new Database(b.file);
    try {
      expect(restarted.prepare("SELECT name FROM systems WHERE id='NEW'").get()).toEqual({
        name: 'After restore',
      });
    } finally {
      restarted.close();
    }
  });
  it('сбой до COMMIT откатывает удаление и вставки; очистка оставляет рабочую схему', async () => {
    const a = profile();
    seed(a.db);
    const b = profile();
    seed(b.db, 'B');
    const file = join(a.directory, 'backup.sqlite');
    await backups.backup(a.db, file);
    backups.prepare(file);
    const before = dump(b.db);
    expect(() =>
      backups.replace(b.db, file, () => {
        throw new Error('simulated interruption');
      }),
    ).toThrow('simulated');
    expect(dump(b.db)).toEqual(before);
    expect(b.db.pragma('foreign_keys', { simple: true })).toBe(1);
    backups.clear(b.db);
    expect(b.db.prepare('SELECT * FROM operations').all()).toEqual([]);
    expect(b.db.prepare('SELECT * FROM __drizzle_migrations').all()).toHaveLength(25);
    seed(b.db, 'FIRST');
  });
  it('отклоняет новую, неизвестную, чужую и повреждённую БД без изменения рабочей', async () => {
    const a = profile();
    seed(a.db);
    const before = dump(a.db);
    for (const change of [
      (db: Database.Database) =>
        db.exec(
          "INSERT INTO __drizzle_migrations(hash,created_at) VALUES ('future',9999999999999)",
        ),
      (db: Database.Database) => db.exec("UPDATE __drizzle_migrations SET hash='unknown'"),
      (db: Database.Database) => db.exec('CREATE TABLE unexpected(id TEXT)'),
      (db: Database.Database) => db.pragma('user_version = 999'),
    ]) {
      const file = join(a.directory, 'bad.sqlite');
      await backups.backup(a.db, file);
      const bad = new Database(file);
      change(bad);
      bad.close();
      expect(() => backups.prepare(file)).toThrow();
      expect(dump(a.db)).toEqual(before);
    }
    const broken = join(a.directory, 'broken.sqlite');
    writeFileSync(broken, 'not SQLite');
    expect(() => backups.prepare(broken)).toThrow(/повреждён/);
  });
  it('SIGKILL внутри транзакции сохраняет прежний профиль после открытия', async () => {
    const a = profile();
    seed(a.db);
    const b = profile();
    seed(b.db, 'B');
    const before = dump(b.db);
    const file = join(a.directory, 'snapshot.sqlite');
    await backups.backup(a.db, file);
    backups.prepare(file);
    b.db.close();
    const root = resolve(__dirname, '../../../..');
    const script = join(a.directory, 'crash.cjs');
    writeFileSync(
      script,
      `
      const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
      const { PortfolioBackup } = require(${JSON.stringify(join(__dirname, 'portfolio-backup.ts'))});
      const db = new Database(${JSON.stringify(b.file)});
      new PortfolioBackup(${JSON.stringify(migrations)}).replace(db, ${JSON.stringify(file)}, () => process.kill(process.pid, 'SIGKILL'));
    `,
    );
    const child = spawnSync(process.execPath, ['--require', require.resolve('tsx/cjs'), script], {
      env: { ...process.env, TSX_TSCONFIG_PATH: join(root, 'apps/api/tsconfig.app.json') },
      timeout: 10000,
    });
    expect(child.signal, child.stderr?.toString()).toBe('SIGKILL');
    const reopened = new Database(b.file);
    try {
      expect(dump(reopened)).toEqual(before);
      expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      reopened.close();
    }
  });
  it('запись через второе соединение во время Backup API сохраняет согласованный снимок', async () => {
    const a = profile();
    seed(a.db);
    const writer = new Database(a.file);
    const file = join(a.directory, 'parallel.sqlite');
    try {
      const pending = backups.backup(a.db, file);
      writer.transaction(() => seed(writer, 'PARALLEL'))();
      await pending;
      const summary = backups.prepare(file);
      expect(summary.accounts).toBe(summary.operations);
      expect(summary.systems).toBe(summary.operations);
      expect(summary.operations).toBeGreaterThanOrEqual(1);
    } finally {
      writer.close();
    }
  });
  it('мигрирует известную старую версию на временной копии', async () => {
    const a = profile();
    const oldFolder = join(a.directory, 'old-migrations');
    cpSync(migrations, oldFolder, { recursive: true });
    const journalFile = join(oldFolder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
    journal.entries = journal.entries.slice(0, 17);
    writeFileSync(journalFile, JSON.stringify(journal));
    const file = join(a.directory, 'old.sqlite');
    const old = new Database(file);
    applyMigrations(old, oldFolder);
    old.close();
    expect(backups.prepare(file).operations).toBe(0);
    backups.replace(a.db, file);
    expect(a.db.prepare('SELECT * FROM __drizzle_migrations').all()).toHaveLength(25);
  });

  it('принимает прежний хеш 0011 без изменения истории, сохраняя строгую проверку схемы', async () => {
    const a = profile();
    seed(a.db);
    const legacyHash = 'd64d560f657a17d42e5d6b52bfa7e98af7f3fe5c3191cae5a9671f1498f86a10';
    const createdAt = 1794040857958;
    a.db.prepare('UPDATE __drizzle_migrations SET hash=? WHERE created_at=?')
      .run(legacyHash, createdAt);
    const before = dump(a.db);
    expect(backups.inspect(a.file)).toEqual({ appliedMigrations: 25, availableMigrations: 25 });
    const file = join(a.directory, 'legacy.sqlite');
    await backups.backup(a.db, file);
    expect(backups.prepare(file)).toEqual({ accounts: 1, operations: 1, systems: 1 });
    const restored = new Database(file);
    try {
      expect(dump(restored)).toEqual(before);
      restored.exec('CREATE TABLE unexpected(id TEXT)');
      expect(() => backups.inspect(file)).toThrow(/структур/);
      restored.exec('DROP TABLE unexpected');
      restored.prepare('UPDATE __drizzle_migrations SET created_at=? WHERE created_at=?')
        .run(createdAt + 1, createdAt);
      expect(() => backups.inspect(file)).toThrow(/верси/);
      restored.prepare('UPDATE __drizzle_migrations SET created_at=?,hash=? WHERE created_at=?')
        .run(createdAt, 'unknown', createdAt + 1);
      expect(() => backups.inspect(file)).toThrow(/верси/);
    } finally {
      restored.close();
    }
    expect(dump(a.db)).toEqual(before);
  });
});
