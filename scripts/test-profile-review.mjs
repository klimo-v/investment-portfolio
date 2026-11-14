import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const temporary = mkdtempSync(join(tmpdir(), 'portfolio review 2ab '));
const application = join(temporary, 'Old Application');
cpSync(join(root, 'dist/mac-arm64'), application, { recursive: true, verbatimSymlinks: true });
const newer = join(temporary, 'New Application');
const data = join(temporary, 'User Data'); mkdirSync(data);
const envFile = join(temporary, 'Separate Settings.env');
const tokens = ['synthetic-old-review-token', 'synthetic-new-review-token', 'synthetic-inherited-review-token'];
writeFileSync(envFile, `TBANK_TOKEN=${tokens[0]}\n`);
const env = { HOME: temporary, PATH: '/usr/bin:/bin', DATA_DIR: data, ENV_FILE: envFile };
const safe = (text) => assert.ok(tokens.every(token => !text.includes(token)), 'В вывод попал синтетический секрет');
function command(app, action, input = {}, extra = {}) {
  const result = spawnSync(join(app, 'start.sh'), ['profile', action], { cwd: temporary, env: { ...env, ...extra }, input: JSON.stringify(input), encoding: 'utf8', timeout: 120_000 });
  safe((result.stdout ?? '') + (result.stderr ?? ''));
  assert.ok(!result.error, 'Команда не должна зависать или завершаться ошибкой spawn');
  return { code: result.status, value: JSON.parse(result.status === 0 ? result.stdout : result.stderr) };
}
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(done => probe.close(done));
const base = `http://127.0.0.1:${port}`;
let child; let log = '';
async function start(app = application, extra = {}) {
  child = spawn(join(app, 'start.sh'), [], { cwd: temporary, env: { ...env, PORT: String(port), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
  for (let i = 0; i < 400; i++) {
    if (child.exitCode !== null || child.signalCode) throw Error('Приложение не запустилось');
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await new Promise(done => setTimeout(done, 50));
  }
  throw Error('Нет готовности');
}
async function stop() { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; safe(log); }
async function add(name) {
  const { generation } = await (await fetch(base + '/api/data/status')).json();
  const response = await fetch(base + '/api/systems', { method: 'POST', headers: { 'content-type': 'application/json', 'x-portfolio-generation': generation }, body: JSON.stringify({ name }) });
  assert.equal(response.status, 201); return (await response.json()).id;
}
async function has(id) { return (await (await fetch(base + '/api/systems')).json()).some(row => row.id === id); }
try {
  assert.equal(command(application, 'init-empty').code, 0);
  assert.equal(command(application, 'status').value.result.tinvestConfigured, true);
  const imported = { token: tokens[1], confirmation: 'IMPORT TBANK_TOKEN' };
  assert.equal(command(application, 'import-tinvest', imported).value.error.code, 'TOKEN_EXISTS');
  assert.equal(command(application, 'import-tinvest', { ...imported, replaceExisting: true }).code, 0);
  assert.ok(!existsSync(join(data, '.env')), 'Перенос использует ENV_FILE');
  const readSettings = readFileSync(envFile, 'utf8');
  assert.ok(readSettings.includes(tokens[1]) && !readSettings.includes(tokens[0]), 'Настройки заменены в активном файле');
  assert.equal(command(application, 'status', {}, { TBANK_TOKEN: tokens[2] }).value.result.tinvestConfigured, true);
  assert.equal(command(application, 'import-tinvest', imported, { TBANK_TOKEN: tokens[2] }).value.error.code, 'TOKEN_EXISTS');
  assert.equal(command(application, 'import-tinvest', { ...imported, replaceExisting: true }, { TBANK_TOKEN: tokens[2] }).value.error.code, 'TOKEN_ENV_OVERRIDE');
  assert.equal(command(application, 'status', {}, { TBANK_TOKEN: '' }).value.result.tinvestConfigured, false);
  assert.equal(command(application, 'import-tinvest', { ...imported, replaceExisting: true }, { TBANK_TOKEN: '' }).value.error.code, 'TOKEN_ENV_OVERRIDE');
  // Перехват только T-Invest на стороне тестового Node; ни один запрос не покидает Mac.
  const observed = join(temporary, 'authorization.sha256');
  const preload = join(temporary, 'mock-tinvest.cjs');
  writeFileSync(preload, `const fs=require('node:fs'),crypto=require('node:crypto');const original=global.fetch;global.fetch=async(url,options)=>{if(String(url).includes('invest-public-api.tbank.ru')){fs.writeFileSync(${JSON.stringify(observed)},crypto.createHash('sha256').update(options.headers.Authorization).digest('hex'));return new Response(JSON.stringify({accounts:[]}),{status:200,headers:{'content-type':'application/json'}})}return original(url,options)};`);
  await start(application, { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` });
  assert.equal((await fetch(base + '/api/import/tbank/accounts')).status, 200);
  const expected = createHash('sha256').update(`Bearer ${tokens[1]}`).digest('hex');
  assert.ok(readFileSync(observed, 'utf8') === expected, 'После перезапуска сервер прочитал новый токен из ENV_FILE');
  const control = await add('Control before update');
  await stop();
  const prepared = command(application, 'prepare-update'); assert.equal(prepared.code, 0);
  const directory = prepared.value.result.backupDirectory;
  await start(); const latest = await add('New record must survive rejected recovery'); await stop();
  const savedNode = join(directory, 'application/runtime/node');
  rmSync(savedNode);
  const refused = command(application, 'recover-update', { directory, confirmation: 'RESTORE UPDATE BACKUP' });
  assert.equal(refused.value.error.code, 'RECOVERY_DAMAGED');
  await start(); assert.ok(await has(latest), 'Отказ сохранил новую запись текущего портфеля'); await stop();
  cpSync(join(application, 'runtime/node'), savedNode);
  // Формат прежних пар: только пятифайловый applicationId, без полного digest.
  const manifestFile = join(directory, 'recovery.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const oldId = createHash('sha256').update(['server/main.js', 'server/migrations/meta/_journal.json', 'web/index.html', 'launch.mjs', 'build-manifest.json'].map(file => createHash('sha256').update(readFileSync(join(directory, 'application', file))).digest('hex')).join('')).digest('hex');
  assert.equal(manifest.applicationId, oldId, 'applicationId понятен прежнему приложению');
  delete manifest.applicationDigest; writeFileSync(manifestFile, JSON.stringify(manifest));
  rmSync(savedNode);
  assert.equal(command(application, 'recover-update', { directory, confirmation: 'RESTORE UPDATE BACKUP' }).value.error.code, 'RECOVERY_DAMAGED');
  cpSync(join(application, 'runtime/node'), savedNode);
  cpSync(application, newer, { recursive: true, verbatimSymlinks: true });
  const journalFile = join(newer, 'server/migrations/meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
  const last = journal.entries.at(-1);
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag: '9999_synthetic_failure' });
  writeFileSync(journalFile, JSON.stringify(journal));
  writeFileSync(join(newer, 'server/migrations/9999_synthetic_failure.sql'), 'INVALID SYNTHETIC MIGRATION;');
  const failed = spawnSync(join(newer, 'start.sh'), [], { cwd: temporary, env: { ...env, PORT: String(port) }, encoding: 'utf8', timeout: 120_000 });
  safe((failed.stdout ?? '') + (failed.stderr ?? '')); assert.equal(failed.status, 1);
  assert.equal(readdirSync(join(data, 'backups')).filter(name => name.startsWith('update-')).length, 2, 'Создана автоматическая предмиграционная пара');
  const inspect = spawnSync(join(application, 'runtime/node'), ['-e', `const D=require('./node_modules/better-sqlite3');const d=new D(${JSON.stringify(join(data, 'portfolio.sqlite'))});console.log(JSON.stringify({n:d.prepare('select count(*) as n from __drizzle_migrations').get().n,hasLatest:!!d.prepare('select id from systems where id=?').get(${JSON.stringify(latest)})}));d.close()`], { cwd: application, env, encoding: 'utf8' });
  assert.equal(inspect.status, 0);
  assert.deepEqual(JSON.parse(inspect.stdout), { n: journal.entries.length - 1, hasLatest: true });
  // Откат вызывается именно новой версией, пока рабочая БД осталась в старой схеме.
  const recovered = command(newer, 'recover-update', { directory, confirmation: 'RESTORE UPDATE BACKUP' });
  assert.equal(recovered.code, 0);
  assert.ok(existsSync(join(recovered.value.result.safetyBackup, 'portfolio.sqlite')));
  await start(resolve(recovered.value.result.launchPath, '..'));
  assert.ok(await has(control), 'Возвращённое приложение реально читает контрольную запись');
  await stop();
  console.log(JSON.stringify({ result: 'PASS', temporary, checks: ['incomplete runtime refused before replacement; current record preserved', 'failed migration rollback via new start.sh; returned application launched and control read', 'ENV_FILE token detection, replacement confirmation, restarted server authorization', 'inherited token override refused; no secrets in output'] }, null, 2));
} finally {
  if (child && child.exitCode === null && !child.signalCode) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
  safe(log); writeFileSync(join(temporary, 'server.log'), log);
}
