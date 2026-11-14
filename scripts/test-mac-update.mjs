import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packageApp, hash } from './lib/mac-package.mjs';

const args = process.argv.slice(2);
const value = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const previousDmg = value('--previous'); const nextDmg = value('--next');
if (!previousDmg || !nextDmg) throw Error('pnpm test:mac:update --previous /path/previous.dmg --next /path/new.dmg [--first-release] [--legacy-backup /path/anonymous.sqlite]');
const root = resolve(import.meta.dirname, '..');
const temporary = mkdtempSync(join(tmpdir(), 'portfolio DMG acceptance '));
const reports = join(root, 'dist/mac-acceptance'); mkdirSync(reports, { recursive: true });
const run = (name, argv) => execFileSync(name, argv, { encoding: 'utf8' });
const wait = ms => new Promise(done => setTimeout(done, ms));
const report = { result: 'RUNNING', temporary, inputs: { previousDmg: resolve(previousDmg), previousSha256: hash(resolve(previousDmg)), nextDmg: resolve(nextDmg), nextSha256: hash(resolve(nextDmg)), firstRelease: args.includes('--first-release') }, checks: [] };
const reportFile = join(reports, `update-${new Date().toISOString().replaceAll(':', '-')}.json`);
let active;
async function until(predicate, description, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await wait(150); }
  throw Error(`Timeout: ${description}; state=${JSON.stringify(active?.state())}`);
}
function extract(dmg, name) {
  const mount = join(temporary, `mount-${name}`); mkdirSync(mount);
  run('/usr/bin/hdiutil', ['attach', resolve(dmg), '-readonly', '-nobrowse', '-mountpoint', mount]);
  const target = join(temporary, name, 'Investment Portfolio.app'); mkdirSync(join(temporary, name));
  try { run('/usr/bin/ditto', [join(mount, 'Investment Portfolio.app'), target]); }
  finally { run('/usr/bin/hdiutil', ['detach', mount]); }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]); return target;
}
const runtime = app => join(app, 'Contents/Resources/Runtime');
const metadata = app => JSON.parse(readFileSync(join(runtime(app), 'build-manifest.json'))).application;
const previous = extract(previousDmg, 'previous'); const next = extract(nextDmg, 'next');
assert.equal(hash(resolve(previousDmg)), report.inputs.previousSha256, 'Предыдущий DMG изменился во время установки');
assert.equal(hash(resolve(nextDmg)), report.inputs.nextSha256, 'Новый DMG изменился во время установки; дождитесь окончания выпуска');
report.previous = metadata(previous); report.next = metadata(next);
assert.notDeepEqual([report.previous.version, report.previous.build], [report.next.version, report.next.build], 'Сборки должны различаться');
if (args.includes('--first-release')) {
  assert.equal(report.previous.channel, 'local-test'); assert.equal(report.next.channel, 'local-test');
} else { assert.equal(report.previous.channel, 'release', 'Для следующих выпусков нужен DMG настоящего предыдущего релиза'); }
const modules = createRequire(join(runtime(next), 'package.json'));
const Database = modules('better-sqlite3');
async function freePort() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(done => s.close(done)); return p; }
function cli(app, data, action, input = {}) {
  const result = spawnSync(join(runtime(app), 'start.sh'), ['profile', action], { cwd: temporary, env: { HOME: temporary, PATH: '/usr/bin:/bin', DATA_DIR: data, ENV_FILE: join(data, '.env') }, input: JSON.stringify(input), encoding: 'utf8', timeout: 180_000 });
  assert.equal(result.error, undefined);
  const response = JSON.parse(result.status === 0 ? result.stdout : result.stderr);
  assert.equal(result.status, 0, JSON.stringify(response)); return response.result;
}
function harness(name, dataOverride) {
  const directory = join(temporary, name); mkdirSync(directory);
  const data = dataOverride ?? join(directory, 'User Data'); mkdirSync(data, { recursive: true });
  const control = join(directory, 'Control'); mkdirSync(control);
  const installed = join(directory, 'Applications/Investment Portfolio.app'); mkdirSync(join(directory, 'Applications'));
  let port;
  const h = {
    data, control, installed,
    state: () => { try { return JSON.parse(readFileSync(join(control, 'state.json'))); } catch { return {}; } },
    async install(app) { assert.ok(!this.alive(), 'Перед заменой приложение должно завершиться'); rmSync(installed, { recursive: true, force: true }); run('/usr/bin/ditto', [app, installed]); },
    alive() { const pid = this.state().pid; if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } },
    async launch({ expect = 'ready' } = {}) {
      active = this; if (!port) port = await freePort();
      rmSync(join(control, 'state.json'), { force: true });
      run('/usr/bin/open', ['-n', '-a', installed, '--args', '--test-profile', data, '--test-control', control, '--test-port', String(port), '--no-browser']);
      return until(() => { const s = this.state(); return (expect === 'ready' ? s.ready : expect === 'onboarding' ? s.onboarding && !s.busy : s.state === 'Ошибка' && !s.busy) && s; }, `${name} launch ${expect}`);
    },
    async command(action, source) {
      writeFileSync(join(control, 'next-command.tmp'), JSON.stringify({ action, ...(source ? { source } : {}) })); renameSync(join(control, 'next-command.tmp'), join(control, 'command.json'));
      await until(() => !existsSync(join(control, 'command.json')), `consume ${action}`);
    },
    async quit() { if (!this.alive()) return; await this.command('quit'); await until(() => !this.alive(), `${name} quit`, 30_000); },
    async ready() { return until(() => this.state().ready && this.state(), `${name} ready`); },
    async api(path, body, method = body === undefined ? 'GET' : 'POST') {
      const headers = {};
      if (method !== 'GET') { const status = await this.api('/api/data/status'); headers['x-portfolio-generation'] = status.generation; headers['content-type'] = 'application/json'; headers.origin = `http://127.0.0.1:${port}`; }
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      const output = await response.json(); assert.ok(response.ok, `${path}: ${JSON.stringify(output)}`); return output;
    },
    async raw(path, options = {}) { return fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(10_000) }); },
    base: () => `http://127.0.0.1:${port}`,
  }; return h;
}
async function seed(h) {
  const portfolio = await h.api('/api/portfolios', { name: 'Тестовый счёт DMG', accountRef: 'LOCAL-TEST-001' });
  const system = await h.api('/api/systems', { name: 'Тестовая система DMG' });
  const operation = { id: 'dmg-control-deposit', date: '2026-11-10', portfolioId: portfolio.id, systemId: system.id, operationType: 'Deposit', quantity: '1', price: '10000.25', currency: 'RUB' };
  await h.api('/api/operations', operation);
  await h.api('/api/operations', { ...operation, id: 'dmg-control-withdraw', date: '2026-11-11', operationType: 'Withdraw', price: '1000.10' });
  return { portfolio, system, operation };
}
async function controls(h, ids) {
  const portfolios = await h.api('/api/portfolios'); const operations = await h.api('/api/operations');
  const summary = await h.api(`/api/operations/summary?portfolioId=${ids.portfolio.id}&from=2026-11-01&till=2026-11-14`);
  const operation = operations.find(row => row.id === ids.operation.id);
  return { account: portfolios.find(row => row.id === ids.portfolio.id), operation, count: operations.length, totalRub: String(summary.cash.totalValueRub), cash: summary.cash };
}
function inspect(data) { const db = new Database(join(data, 'portfolio.sqlite'), { readonly: true }); try { return { migrations: db.prepare('select count(*) as n from __drizzle_migrations').get().n, integrity: db.pragma('integrity_check', { simple: true }) }; } finally { db.close(); } }
async function migrationFixture(app, name, version, broken) {
  const source = join(temporary, `${name}-runtime`); cpSync(runtime(app), source, { recursive: true, verbatimSymlinks: true });
  const path = join(source, 'server/migrations/meta/_journal.json'); const journal = JSON.parse(readFileSync(path)); const last = journal.entries.at(-1);
  const tag = broken ? '9999_acceptance_failure' : '9998_acceptance_success';
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag }); writeFileSync(path, JSON.stringify(journal));
  writeFileSync(join(source, `server/migrations/${tag}.sql`), broken ? 'INVALID ACCEPTANCE MIGRATION;' : 'CREATE TABLE acceptance_migration_probe (id text PRIMARY KEY NOT NULL);');
  const result = packageApp({ version, build: broken ? '902' : '901', channel: `local-fixture-${name}`, runtimeSource: source, outputDirectory: join(temporary, `fixture-${name}`) });
  report.inputs[name] = { dmg: result.dmg, sha256: result.dmgSha256, purpose: broken ? 'synthetic failed migration' : 'synthetic schema migration' };
  return extract(result.dmg, `extracted-${name}`);
}
try {
  // Два готовых релизных DMG, одинаковый каталог установки и профиль.
  const normal = harness('ordinary-update'); active = normal;
  await normal.install(previous); await normal.launch({ expect: 'onboarding' }); await normal.command('init-empty'); await normal.ready();
  const ids = await seed(normal); const before = await controls(normal, ids);
  assert.equal(before.count, 2); assert.equal(before.totalRub, '9000.15'); assert.equal(before.operation.date, '2026-11-10'); assert.equal(before.operation.price, '10000.25');
  // Скачанный сервером файл — тот же контракт, что у кнопки в разделе «Данные».
  const backup = join(temporary, 'downloaded-anonymous.sqlite'); writeFileSync(backup, Buffer.from(await (await normal.raw('/api/data/backup')).arrayBuffer()));
  await normal.quit(); await normal.install(next); const state = await normal.launch();
  assert.equal(state.version, report.next.version); assert.equal(state.build, report.next.build); assert.equal(state.onboarding, false);
  const health = await normal.api('/api/health'); assert.equal(health.instance, state.instance); assert.equal(health.version, report.next.version);
  const after = await controls(normal, ids); assert.deepEqual(after, before);
  await normal.api('/api/operations', { ...ids.operation, id: 'dmg-after-update', date: '2026-11-12', price: '500.05' });
  await normal.quit(); await normal.launch(); const restarted = await controls(normal, ids);
  assert.equal(restarted.count, 3); assert.equal(restarted.totalRub, '9500.2'); assert.ok((await normal.api('/api/operations')).some(row => row.id === 'dmg-after-update'));
  // Запуск/остановка и повторные команды меню не создают второй сервер.
  const originalPid = normal.state().serverPid; await normal.command('start'); assert.equal(normal.state().serverPid, originalPid);
  await normal.command('stop'); await until(() => normal.state().state === 'Остановлен', 'stop');
  const occupied = createServer(socket => socket.end('occupied')); occupied.listen(normal.state().port, '127.0.0.1'); await once(occupied, 'listening');
  await normal.command('start'); await until(() => normal.state().state === 'Ошибка', 'port conflict'); assert.ok(normal.state().error.includes('занят')); assert.equal(occupied.listening, true);
  await new Promise(done => occupied.close(done)); await normal.command('start'); await normal.ready();
  // Авария меню: launcher замечает смену ppid и завершает только свой сервер.
  const crashed = normal.state(); process.kill(crashed.pid, 'SIGKILL'); await until(() => !normal.alive(), 'GUI crash exit');
  await until(async () => { try { await normal.raw('/api/health'); return false; } catch { return true; } }, 'orphan server exit', 15_000);
  await normal.launch(); assert.deepEqual(await controls(normal, ids), restarted); await normal.quit();
  report.checks.push('ordinary update from two supplied DMGs; new version and own health identity; no onboarding; extra operation survives restart; repeated start; stop; foreign port survives; GUI crash/reopen');
  report.controls = { before, after, afterAdditionalOperationAndRestart: restarted };
  console.log('PASS: ordinary update, control values, additional operation, restart, process ownership');
  const downloadedData = join(temporary, 'downloaded-restore-profile'); mkdirSync(downloadedData);
  cli(next, downloadedData, 'restore', { source: backup }); const restored = harness('downloaded-restore', downloadedData);
  await restored.install(next); await restored.launch(); assert.deepEqual(await controls(restored, ids), before); await restored.quit();
  report.checks.push('restore of single file downloaded from finished previous DMG server');

  // Отдельная обезличенная копия со старым hash 0011; импорт именно HTTP-сервером нового DMG.
  const legacy = join(temporary, 'historical-0011-anonymous.sqlite');
  cpSync(value('--legacy-backup') ? resolve(value('--legacy-backup')) : backup, legacy);
  if (!value('--legacy-backup')) {
    const db = new Database(legacy); db.prepare('UPDATE __drizzle_migrations SET hash=? WHERE created_at=?').run('d64d560f657a17d42e5d6b52bfa7e98af7f3fe5c3191cae5a9671f1498f86a10', 1794040857958); db.close();
  }
  report.legacyBackup = { path: legacy, origin: value('--legacy-backup') ? 'supplied anonymized historical backup' : 'synthetic anonymized portfolio; exact historical 0011 hash from affected profile' };
  const imported = harness('historical-restore'); await imported.install(next); await imported.launch({ expect: 'onboarding' }); await imported.command('init-empty'); await imported.ready();
  const generation = (await imported.api('/api/data/status')).generation;
  const response = await imported.raw('/api/data/preview', { method: 'POST', headers: { origin: imported.base(), 'content-type': 'application/octet-stream', 'x-portfolio-generation': generation }, body: readFileSync(legacy) });
  const preview = await response.json(); assert.equal(response.status, 200, JSON.stringify(preview));
  await imported.api('/api/data/restore', { id: preview.id, confirmation: 'REPLACE' });
  if (!value('--legacy-backup')) assert.deepEqual(await controls(imported, ids), before);
  else {
    const source = new Database(legacy, { readonly: true });
    try {
      const count = source.prepare('SELECT count(*) AS n FROM operations').get().n;
      const original = source.prepare('SELECT id,date,price,portfolio_id FROM operations ORDER BY id LIMIT 1').get();
      const operations = await imported.api('/api/operations');
      assert.equal(operations.length, count); assert.equal(preview.operations, count);
      if (original) {
        const operation = operations.find(row => row.id === original.id);
        assert.equal(operation.date, original.date); assert.equal(operation.price, original.price); assert.equal(operation.portfolioId, original.portfolio_id);
      }
      if (operations.some(row => row.id === 'legacy-deposit')) {
        const summary = await imported.api('/api/operations/summary?portfolioId=legacy-account&from=2026-11-01&till=2026-11-14');
        assert.equal(String(summary.cash.totalValueRub), '9000.15');
        report.legacyBackup.controls = { account: 'Обезличенный старый счёт', operationDate: '2026-11-10', operationAmountRub: '10000.25', operations: count, totalRub: String(summary.cash.totalValueRub) };
      }
    } finally { source.close(); }
  }
  await imported.quit(); await imported.launch(); await imported.quit();
  report.checks.push('historical 0011 backup imported with preview/restore HTTP endpoints from server extracted from new DMG; restart successful');
  console.log('PASS: downloaded backup and historical 0011 through packaged HTTP server');

  // Готовые дополнительные DMG с явно обозначенными синтетическими миграциями.
  const migratedApp = await migrationFixture(next, 'migration', '0.1.2', false);
  const brokenApp = await migrationFixture(next, 'failure', '0.1.3', true);
  const migration = harness('migration-update'); await migration.install(next); await migration.launch({ expect: 'onboarding' }); await migration.command('init-empty'); await migration.ready();
  const mid = await seed(migration); const migrationBefore = await controls(migration, mid); const schemaBefore = inspect(migration.data);
  await migration.quit(); await migration.install(migratedApp); await migration.launch();
  assert.equal(inspect(migration.data).migrations, schemaBefore.migrations + 1); assert.deepEqual(await controls(migration, mid), migrationBefore);
  await migration.quit(); const pairs = readdirSync(join(migration.data, 'backups')).filter(name => name.startsWith('update-')); assert.equal(pairs.length, 1);
  await migration.launch(); await migration.command('stop'); await until(() => migration.state().state === 'Остановлен', 'stop migrated server');
  await migration.command('recover', join(migration.data, 'backups', pairs[0])); await migration.ready();
  assert.equal(inspect(migration.data).migrations, schemaBefore.migrations); assert.deepEqual(await controls(migration, mid), migrationBefore);
  const savedRuntime = migration.state().runtime;
  assert.ok(savedRuntime.includes('/backups/'));
  await migration.api('/api/operations', { ...mid.operation, id: 'dmg-after-rollback', date: '2026-11-13', price: '700.07' });
  const afterRollbackWrite = await controls(migration, mid);
  assert.equal(afterRollbackWrite.count, 3); assert.equal(afterRollbackWrite.totalRub, '9700.22');
  const pairsBeforeReopen = readdirSync(join(migration.data, 'backups')).sort();
  await migration.quit(); await migration.launch();
  assert.equal(realpathSync(migration.state().runtime), realpathSync(savedRuntime));
  assert.deepEqual(await controls(migration, mid), afterRollbackWrite);
  assert.ok((await migration.api('/api/operations')).some(row => row.id === 'dmg-after-rollback'));
  assert.deepEqual(readdirSync(join(migration.data, 'backups')).sort(), pairsBeforeReopen, 'Повторное открытие не создаёт восстановление или страховочную пару');
  await migration.command('stop'); await until(() => migration.state().state === 'Остановлен', 'stop reopened rollback server');
  await migration.command('start'); await migration.ready();
  assert.deepEqual(await controls(migration, mid), afterRollbackWrite);
  await migration.quit();
  report.migration = { before: schemaBefore, after: { migrations: schemaBefore.migrations + 1, integrity: 'ok' }, recovered: inspect(migration.data), controls: migrationBefore, afterRollbackWriteAndReopen: afterRollbackWrite, savedRuntime };
  report.checks.push('schema migration and menu rollback; extra operation survives full GUI quit/reopen and menu stop/start; same saved runtime and current DB; no snapshot restoration');

  const failure = harness('failed-update'); await failure.install(next); await failure.launch({ expect: 'onboarding' }); await failure.command('init-empty'); await failure.ready();
  const fid = await seed(failure);
  await failure.api('/api/operations', { ...fid.operation, id: 'last-before-failed-update', date: '2026-11-12', price: '500.05' });
  const failureBefore = await controls(failure, fid); await failure.quit(); const originalHash = hash(join(failure.data, 'portfolio.sqlite'));
  await failure.install(brokenApp); await failure.launch({ expect: 'error' });
  assert.equal(hash(join(failure.data, 'portfolio.sqlite')), originalHash, 'Ошибка миграции не меняет рабочую БД');
  const failedPairs = readdirSync(join(failure.data, 'backups')).filter(name => name.startsWith('update-')); assert.equal(failedPairs.length, 1);
  await failure.command('recover', join(failure.data, 'backups', failedPairs[0])); await failure.ready();
  const failureRecovered = await controls(failure, fid); assert.deepEqual(failureRecovered, failureBefore);
  await failure.api('/api/operations', { ...fid.operation, id: 'dmg-after-failed-rollback', date: '2026-11-13', price: '700.07' });
  const afterFailureWrite = await controls(failure, fid); const failureRuntime = failure.state().runtime;
  await failure.quit(); await failure.launch();
  assert.equal(realpathSync(failure.state().runtime), realpathSync(failureRuntime));
  assert.deepEqual(await controls(failure, fid), afterFailureWrite);
  assert.equal(afterFailureWrite.count, 4); assert.equal(afterFailureWrite.totalRub, '10200.27');
  assert.ok((await failure.api('/api/operations')).some(row => row.id === 'dmg-after-failed-rollback'));
  await failure.quit();
  report.failure = { before: failureBefore, afterRecovery: failureRecovered, unchangedDatabaseSha256: originalHash };
  report.checks.push('bad migration from ready fixture DMG leaves working DB byte-identical; GUI recovery starts saved previous runtime and reads all control operations');
  assert.equal(hash(resolve(previousDmg)), report.inputs.previousSha256);
  assert.equal(hash(resolve(nextDmg)), report.inputs.nextSha256);
  report.result = 'PASS';
} catch (error) {
  report.result = 'FAIL'; report.error = error.stack; throw error;
} finally {
  await active?.quit().catch(() => {});
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ result: report.result, reportFile, temporary, controls: report.controls }, null, 2));
}
