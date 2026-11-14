import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { applyMigrations } from './apply-migrations';

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

// В существующем локальном профиле 0011_strategy_configs имеет прежний хеш,
// при этом итоговая DDL-схема полностью совпадает с текущими миграциями.
// Принимаем только эту конкретную пару хешей и timestamp; ниже по-прежнему
// проверяется точное совпадение всей схемы. Историю рабочей базы не переписываем.
const LEGACY_STRATEGY_MIGRATION = {
  createdAt: 1794040857958,
  currentHash: '141d0a2b7d94b66733c2f29c24dfb8efae0e6928cccdcc79c1be7652be944b88',
  legacyHash: 'd64d560f657a17d42e5d6b52bfa7e98af7f3fe5c3191cae5a9671f1498f86a10',
};

function matchesMigration(
  row: { hash: string; created_at: number },
  known: { hash: string; folderMillis: number },
): boolean {
  if (row.created_at !== known.folderMillis) return false;
  return row.hash === known.hash || (
    row.created_at === LEGACY_STRATEGY_MIGRATION.createdAt &&
    known.hash === LEGACY_STRATEGY_MIGRATION.currentHash &&
    row.hash === LEGACY_STRATEGY_MIGRATION.legacyHash
  );
}

interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}
function schema(db: Database.Database): SchemaRow[] {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name`,
    )
    .all() as SchemaRow[];
}
function check(db: Database.Database): void {
  if (
    db.pragma('integrity_check', { simple: true }) !== 'ok' ||
    (db.pragma('foreign_key_check') as unknown[]).length
  ) {
    throw new Error('Нарушена целостность базы данных.');
  }
}

/** Общий механизм для HTTP и вызова до HTTP в задаче 2Б. Не импортирует живой client. */
export class PortfolioBackup {
  constructor(private readonly migrationsFolder: string) {}

  temporary(): { directory: string; file: string; dispose: () => void } {
    const directory = mkdtempSync(join(tmpdir(), 'portfolio-data-'));
    return {
      directory,
      file: join(directory, 'portfolio.sqlite'),
      dispose: () => rmSync(directory, { recursive: true, force: true }),
    };
  }

  /** SQLite Backup API включает зафиксированный WAL; результат — один автономный файл. */
  async backup(source: Database.Database, destination: string): Promise<void> {
    await source.backup(destination);
    chmodSync(destination, 0o600);
    const copy = new Database(destination);
    try {
      copy.pragma('journal_mode = DELETE');
      check(copy);
    } finally {
      copy.close();
    }
  }

  /** Проверка без миграций: нужна для предмиграционного снимка и отката пары. */
  inspect(file: string): { appliedMigrations: number; availableMigrations: number } {
    const database = new Database(file, { readonly: true, fileMustExist: true });
    try {
      return this.validateSchema(database);
    } finally {
      database.close();
    }
  }

  private validateSchema(database: Database.Database): {
    appliedMigrations: number;
    availableMigrations: number;
  } {
    const reference = new Database(':memory:');
    try {
      database.pragma('trusted_schema = OFF');
      check(database);
      if (
        database.pragma('user_version', { simple: true }) !== 0 ||
        database.pragma('application_id', { simple: true }) !== 0
      ) {
        throw new Error('База более новой или неизвестной версии. Обновите приложение.');
      }
      const known = readMigrationFiles({ migrationsFolder: this.migrationsFolder });
      const history = database
        .prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at')
        .all() as { hash: string; created_at: number }[];
      if (
        !history.length ||
        history.length > known.length ||
        history.some(
          (row, i) => !matchesMigration(row, known[i]),
        )
      ) {
        throw new Error('База более новой или неизвестной версии. Обновите приложение.');
      }
      // Проверяем точную схему известной версии ДО исполнения миграций из приложения.
      const internals = drizzle(reference) as unknown as {
        dialect: {
          migrate: (
            list: typeof known,
            session: unknown,
            config: { migrationsFolder: string },
          ) => void;
        };
        session: unknown;
      };
      internals.dialect.migrate(known.slice(0, history.length), internals.session, {
        migrationsFolder: this.migrationsFolder,
      });
      if (JSON.stringify(schema(database)) !== JSON.stringify(schema(reference))) {
        throw new Error('Неизвестная структура базы данных.');
      }
      return { appliedMigrations: history.length, availableMigrations: known.length };
    } finally {
      reference.close();
    }
  }

  /** Входной файл должен быть частной временной копией: миграции изменяют его. */
  prepare(file: string): { accounts: number; operations: number; systems: number } {
    let copy: Database.Database | undefined;
    try {
      copy = new Database(file, { fileMustExist: true });
      this.validateSchema(copy);
      copy.pragma('foreign_keys = ON');
      applyMigrations(copy, this.migrationsFolder);
      check(copy);
      copy.pragma('journal_mode = DELETE');
      const prepared = copy;
      const count = (table: string): number =>
        (prepared.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get() as { n: number }).n;
      return {
        accounts: count('portfolios'),
        operations: count('operations'),
        systems: count('systems'),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        !error.message.startsWith('SQLITE') &&
        /верси|структур|целостност/.test(error.message)
      )
        throw error;
      throw new Error('Файл не является поддерживаемой базой портфеля SQLite или повреждён.');
    } finally {
      copy?.close();
    }
  }

  /** Транзакционная замена содержимого; открытое соединение и все Drizzle-клиенты сохраняются.
   * Вызывающий обеспечивает отсутствие незавершённых асинхронных работ с этим соединением.
   */
  replace(target: Database.Database, preparedFile: string, beforeCommit?: () => void): void {
    const source = new Database(preparedFile, { readonly: true, fileMustExist: true });
    try {
      check(source);
      if (JSON.stringify(schema(source)) !== JSON.stringify(schema(target))) {
        throw new Error('Структура подготовленной базы несовместима с рабочей.');
      }
    } finally {
      source.close();
    }
    target.prepare('ATTACH DATABASE ? AS portfolio_restore').run(preparedFile);
    const foreignKeys = target.pragma('foreign_keys', { simple: true });
    try {
      target.pragma('foreign_keys = OFF');
      target
        .transaction(() => {
          const tables = schema(target).filter((row) => row.type === 'table');
          for (const { name } of tables) target.exec(`DELETE FROM main.${quote(name)}`);
          for (const { name } of tables)
            target.exec(
              `INSERT INTO main.${quote(name)} SELECT * FROM portfolio_restore.${quote(name)}`,
            );
          // Служебный autoincrement тоже входит в снимок, если появился в будущих миграциях.
          if (target.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()) {
            target.exec(
              'DELETE FROM main.sqlite_sequence; INSERT INTO main.sqlite_sequence SELECT * FROM portfolio_restore.sqlite_sequence',
            );
          }
          check(target);
          beforeCommit?.();
        })
        .immediate();
    } finally {
      target.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
      target.exec('DETACH DATABASE portfolio_restore');
    }
  }

  clear(target: Database.Database): void {
    const temporary = this.temporary();
    try {
      const empty = new Database(temporary.file);
      try {
        applyMigrations(empty, this.migrationsFolder);
      } finally {
        empty.close();
      }
      this.replace(target, temporary.file);
    } finally {
      temporary.dispose();
    }
  }
}
