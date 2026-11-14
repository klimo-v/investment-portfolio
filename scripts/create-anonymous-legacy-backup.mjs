import Database from 'better-sqlite3';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
const [sourceArg, destinationArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg) throw Error('node scripts/create-anonymous-legacy-backup.mjs /path/old.sqlite /path/new-anonymous.sqlite');
const source = resolve(sourceArg); const destination = resolve(destinationArg);
if (existsSync(destination)) throw Error('Файл назначения уже существует');
const original = new Database(source, { readonly: true, fileMustExist: true });
try { await original.backup(destination); } finally { original.close(); }
const copy = new Database(destination);
try {
  const legacy = copy.prepare('SELECT hash FROM __drizzle_migrations WHERE created_at=?').get(1794040857958);
  if (legacy?.hash !== 'd64d560f657a17d42e5d6b52bfa7e98af7f3fe5c3191cae5a9671f1498f86a10') throw Error('Источник не содержит историческую 0011; хеш не подменяется');
  copy.pragma('foreign_keys=OFF'); copy.pragma('secure_delete=ON');
  const tables = copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name <> '__drizzle_migrations'").all();
  copy.transaction(() => {
    for (const { name } of tables) copy.exec(`DELETE FROM "${name.replaceAll('"', '""')}"`);
    copy.exec(`INSERT INTO portfolios(id,name,account_ref) VALUES('legacy-account','Обезличенный старый счёт','ANONYMOUS-001');
      INSERT INTO systems(id,name) VALUES('legacy-system','Обезличенная система');
      INSERT INTO operations(id,date,system_id,portfolio_id,operation_type,quantity,price,currency)
      VALUES('legacy-deposit','2026-11-10','legacy-system','legacy-account','Deposit','1','10000.25','RUB'),
      ('legacy-withdraw','2026-11-11','legacy-system','legacy-account','Withdraw','1','1000.10','RUB');`);
  })();
  copy.pragma('journal_mode=DELETE'); copy.exec('VACUUM');
  if (copy.pragma('integrity_check', { simple: true }) !== 'ok' || copy.pragma('foreign_key_check').length) throw Error('Нарушена целостность копии');
  chmodSync(destination, 0o600);
  console.log(JSON.stringify({ destination, origin: 'read-only SQLite Backup API snapshot; all user tables cleared with secure_delete and VACUUM; synthetic account and two operations; original migration history preserved' }));
} catch (error) {
  // Не оставляем под именем «anonymous» частично очищенную копию.
  if (copy.open) copy.close();
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(destination + suffix, { force: true });
  throw error;
} finally { if (copy.open) copy.close(); }
