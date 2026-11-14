import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'portfolio standalone ')));
const resources = join(testRoot, 'Application Resources');
const data = join(testRoot, 'User Data');
const cwd = join(testRoot, 'Other Working Directory');
cpSync(join(root, 'dist/mac-arm64'), resources, { recursive: true, verbatimSymlinks: true });
mkdirSync(data); mkdirSync(cwd);
function audit(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (lstatSync(path).isSymbolicLink()) assert.ok(realpathSync(path).startsWith(resources + '/'), `Внешняя ссылка: ${path}`);
    else if (lstatSync(path).isDirectory()) audit(path);
    else assert.ok(!/(^\.env($|\.)|\.(sqlite|sqlite3|xlsx|csv|html-report)$)/i.test(name), `Личные данные: ${path}`);
  }
}
audit(resources);
assert.deepEqual(readFileSync(join(resources, 'web/3rdpartylicenses.txt')), readFileSync(join(root, 'dist/apps/web/3rdpartylicenses.txt')));
const index = readFileSync(join(resources, 'web/index.html'), 'utf8');
const mainJs = [...index.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)]
  .map((match) => match[1]).find((src) => /(?:^|\/)main[^/]*\.js$/.test(src));
assert.ok(mainJs, 'В index.html есть основной JS Angular');
const mainPath = join(resources, 'web', mainJs);
// Порт ОС выделяет свободным; .env проверяет порядок загрузки до SQLite.
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise((done) => probe.close(done));
writeFileSync(join(data, '.env'), `PORT=${port}\nDB_PATH=from-user-env.sqlite\nAPI_HOST=0.0.0.0\n`);
const base = `http://127.0.0.1:${port}`;
const env = { HOME: testRoot, PATH: '/usr/bin:/bin', DATA_DIR: data, NODE_EXTRA_CA_CERTS: join(resources, 'certs/russian_trusted_root_ca.pem') };
// Другой CA-путь заставляет обёртку записать объединённый сертификат в DATA_DIR.
cpSync(env.NODE_EXTRA_CA_CERTS, join(testRoot, 'Corporate CA.pem'));
env.NODE_EXTRA_CA_CERTS = join(testRoot, 'Corporate CA.pem');
const init = execFileSync(join(resources, 'start.sh'), ['profile', 'init-empty'], { cwd, env, encoding: 'utf8' });
assert.equal(JSON.parse(init).ok, true);
let child;
let log = '';
async function start() {
  child = spawn(join(resources, 'start.sh'), [], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null || child.signalCode) throw new Error(`Сервер завершился: ${log}`);
    try {
      const health = await fetch(`${base}/api/health`);
      if (health.ok) { assert.deepEqual(await health.json(), { status: 'ok', spa: true }); return; }
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Нет готовности: ${log}`);
}
async function stop() {
  // PID launcher-а, а не сервера: проверяет пересылку SIGTERM и ожидание ребёнка.
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('SIGTERM timeout')), 10000); timer.unref(); })]);
  await assert.rejects(fetch(`${base}/api/health`));
  const listener = createServer(); listener.listen(port, '127.0.0.1'); await once(listener, 'listening');
  await new Promise((done) => listener.close(done));
}
try {
  await start();
  for (const route of ['/', '/dashboard', '/operations']) {
    const response = await fetch(base + route); assert.equal(response.status, 200);
    const html = await response.text(); assert.ok(html.includes('<app-root>'));
    for (const asset of [...html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)].map((m) => m[1])) {
      const url = new URL(asset, base);
      const assetResponse = await fetch(url);
      assert.equal(assetResponse.status, 200, asset);
      assert.match(assetResponse.headers.get('content-type') ?? '', asset.endsWith('.css') ? /^text\/css/ : /^(?:text|application)\/javascript/, asset);
      assert.deepEqual(Buffer.from(await assetResponse.arrayBuffer()), readFileSync(join(resources, 'web', url.pathname)), asset);
    }
  }
  renameSync(mainPath, mainPath + '.disabled');
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 503);
    const missing = await fetch(new URL(mainJs, base));
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type') ?? '', /application\/json/);
  } finally { renameSync(mainPath + '.disabled', mainPath); }
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  for (const asset of ['/missing-acceptance.js', '/missing-acceptance.css?test=1']) {
    const missing = await fetch(base + asset);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type') ?? '', /application\/json/);
  }
  assert.equal((await fetch(`${base}/api/not-a-route`)).status, 404);
  const { generation } = await (await fetch(`${base}/api/data/status`)).json();
  const response = await fetch(`${base}/api/systems`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-portfolio-generation': generation }, body: JSON.stringify({ name: 'Temporary acceptance system' }) });
  assert.equal(response.status, 201); const system = await response.json();
  assert.ok((await (await fetch(`${base}/api/systems`)).json()).some((row) => row.id === system.id));
  assert.ok(existsSync(join(data, 'from-user-env.sqlite')));
  assert.ok(existsSync(join(data, 'tmp/extra-ca-certs.pem')));
  assert.ok(!existsSync(join(resources, 'tmp')));
  const ps = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const server = ps.split('\n').find((line) => line.includes(join(resources, 'server/main.js')) && Number(line.trim().split(/\s+/)[1]) === child.pid);
  assert.ok(server, 'Дочерний процесс — вложенный Node');
  const serverPid = Number(server.trim().split(/\s+/)[0]);
  const sockets = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(serverPid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
  assert.ok(sockets.includes(`127.0.0.1:${port}`), sockets);
  assert.ok(!sockets.includes(`*:${port}`), sockets);
  await stop(); assert.throws(() => process.kill(serverPid, 0));
  // Независимое открытие после SIGTERM: миграции и фактическая запись в SQLite.
  const query = `const D=require(${JSON.stringify(join(resources, 'node_modules/better-sqlite3'))});const d=new D(${JSON.stringify(join(data, 'from-user-env.sqlite'))});if(!d.prepare('select * from systems where id=?').get(${JSON.stringify(system.id)}))throw Error('missing row');console.log('migrations',d.prepare('select count(*) as n from __drizzle_migrations').get());if(d.pragma('integrity_check',{simple:true})!=='ok')throw Error('integrity');d.close()`;
  console.log(execFileSync(join(resources, 'runtime/node'), ['-e', query], { cwd, env, encoding: 'utf8' }).trim());
  await start();
  assert.ok((await (await fetch(`${base}/api/systems`)).json()).some((row) => row.id === system.id));
  await stop();
  // Ни неполная SPA, ни сломанный журнал миграций не должны дать ложную готовность.
  for (const file of ['web/index.html', `web/${mainJs}`, 'server/migrations/meta/_journal.json']) {
    const path = join(resources, file);
    renameSync(path, path + '.disabled');
    try {
      child = spawn(join(resources, 'start.sh'), [], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk) => { log += chunk; });
      child.stderr.on('data', (chunk) => { log += chunk; });
      const [code] = await Promise.race([once(child, 'exit'), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Startup failure timeout')), 10000); timer.unref(); })]);
      assert.equal(code, 1, file);
      await assert.rejects(fetch(`${base}/api/health`));
    } finally { renameSync(path + '.disabled', path); }
  }
  console.log(JSON.stringify({ result: 'PASS', resources, data, port, checks: ['relocation/spaces', 'different cwd', 'no Node in PATH', 'internal symlinks only', 'health', 'SPA asset MIME and bytes', 'Angular licenses', 'missing main JS readiness and startup failure', 'missing assets 404 JSON', 'operations deep link', 'API SQLite write/read', 'env before DB', 'user CA bundle', 'SIGTERM wrapper and child', 'port released', 'SQLite integrity', 'restart persistence', 'no private data'] }, null, 2));
} finally {
  if (child && child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
  writeFileSync(join(testRoot, 'server.log'), log);
  console.log(`Временные данные и лог: ${testRoot}`);
}
