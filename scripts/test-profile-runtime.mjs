import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

const root = resolve(import.meta.dirname, '..');
const temporary = mkdtempSync(join(tmpdir(), 'portfolio onboarding '));
const resources = join(temporary, 'Application Resources');
cpSync(join(root, 'dist/mac-arm64'), resources, { recursive: true, verbatimSymlinks: true });
const data = join(temporary, 'User Data'); mkdirSync(data);
const cwd = join(temporary, 'Other cwd'); mkdirSync(cwd);
const env = { HOME: temporary, PATH: '/usr/bin:/bin', DATA_DIR: data };
const secret = 'synthetic-test-token-2b';
function command(action, input, custom = env) {
  const result = spawnSync(join(resources, 'start.sh'), ['profile', action], { cwd, env: custom, input: JSON.stringify(input ?? {}), encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined);
  assert.ok(!((result.stdout ?? '') + (result.stderr ?? '')).includes(secret), 'Токен не попал в вывод');
  return { code: result.status, response: JSON.parse(result.status === 0 ? result.stdout : result.stderr) };
}
assert.equal(command('status').response.result.exists, false);
const dbFile = join(data, 'portfolio.sqlite');
assert.equal(command('restore', { source: join(temporary, 'missing.sqlite') }).response.error.code, 'SOURCE_UNREADABLE');
assert.equal(existsSync(dbFile), false);
const broken = join(temporary, 'broken.sqlite'); writeFileSync(broken, 'broken');
assert.equal(command('restore', { source: broken }).code, 1); assert.equal(existsSync(dbFile), false);
const emptyData = join(temporary, 'Empty Data');
assert.equal(command('init-empty', {}, { ...env, DATA_DIR: emptyData }).response.result.operations, 0);
assert.equal(command('init-empty', {}, { ...env, DATA_DIR: emptyData }).response.error.code, 'PROFILE_EXISTS');

const input = process.env.PORTFOLIO_TEST_UI_BACKUP;
if (!input) throw new Error('Задайте PORTFOLIO_TEST_UI_BACKUP: файл, скачанный интерфейсом 2А');
const source = join(temporary, 'Downloaded from UI.sqlite'); cpSync(input, source);
const preview = command('inspect', { source }); assert.equal(preview.code, 0);
assert.equal(command('restore', { source }).code, 0);
assert.equal(command('restore', { source }).response.error.code, 'PROFILE_EXISTS');
rmSync(source); // Рабочий профиль больше не зависит от исходника.
const sourceEnv = join(temporary, 'old-project.env');
writeFileSync(sourceEnv, `TBANK_TOKEN=${secret}\nPORT=9\nAPI_HOST=0.0.0.0\nDB_PATH=/old-project.sqlite\nNODE_EXTRA_CA_CERTS=/old-ca.pem\n`);
assert.equal(command('import-tinvest', { sourceEnvFile: sourceEnv, confirmation: 'IMPORT TBANK_TOKEN' }).code, 0);
assert.equal(command('import-tinvest', { sourceEnvFile: sourceEnv, confirmation: 'IMPORT TBANK_TOKEN' }).response.error.code, 'TOKEN_EXISTS');
assert.equal(statSync(join(data, '.env')).mode & 0o777, 0o600);
const settings = readFileSync(join(data, '.env'), 'utf8');
for (const forbidden of ['PORT=', 'API_HOST=', 'DB_PATH=', 'NODE_EXTRA_CA_CERTS=']) assert.ok(!settings.includes(forbidden));
assert.equal(command('status').response.result.tinvestConfigured, true);

const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(done => probe.close(done));
const base = `http://127.0.0.1:${port}`; let child; let log = '';
async function start(launcher = join(resources, 'start.sh')) {
  child = spawn(launcher, [], { cwd, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw Error('Сервер не запустился: ' + log);
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await new Promise(done => setTimeout(done, 50));
  }
  throw Error('Нет готовности');
}
async function stop() { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
try {
  await start();
  assert.equal(command('init-empty').response.error.code, 'PROFILE_BUSY');
  const operations = await (await fetch(base + '/api/operations')).json();
  assert.ok(JSON.stringify(operations).includes('1000'));
  const summary = await (await fetch(base + '/api/operations/summary')).json();
  await stop(); await start();
  assert.deepEqual(await (await fetch(base + '/api/operations/summary')).json(), summary);
  await stop();
  const pair = command('prepare-update'); assert.equal(pair.code, 0);
  const directory = pair.response.result.backupDirectory;
  assert.ok(existsSync(join(directory, 'application/start.sh')));
  assert.equal(command('recover-update', { directory, confirmation: 'NO' }).response.error.code, 'CONFIRMATION_REQUIRED');
  const recovery = command('recover-update', { directory, confirmation: 'RESTORE UPDATE BACKUP' }); assert.equal(recovery.code, 0);
  assert.ok(existsSync(recovery.response.result.safetyBackup));
  await start(recovery.response.result.launchPath);
  assert.deepEqual(await (await fetch(base + '/api/operations/summary')).json(), summary);
  await stop();
  assert.ok(!log.includes(secret));
  console.log(JSON.stringify({ result: 'PASS', temporary, operations: preview.response.result.operations,
    checks: ['explicit empty start', 'invalid path without empty DB', 'corrupt input', 'UI backup isolated restore', 'source unavailable', 'no overwrite', 'token allowlist and 0600', 'secret redaction', 'no HTTP for commands', 'live profile lock', 'HTTP after restore', 'restart', 'compatible application/database pair', 'recovery launch'] }, null, 2));
} finally {
  if (child && child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
  writeFileSync(join(temporary, 'server.log'), log);
}
