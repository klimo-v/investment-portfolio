import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(root, 'scripts/mac-runtime.json')));
if (process.platform !== spec.platform || process.arch !== spec.arch) throw new Error('Собирать на macOS arm64 (не под Rosetta)');
const out = join(root, 'dist/mac-arm64');
const cache = join(root, 'tmp/mac-runtime');
mkdirSync(cache, { recursive: true });
const archive = join(cache, 'node.tar.gz');
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
if (!existsSync(archive)) execFileSync('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', spec.url, '-o', archive], { stdio: 'inherit' });
if (sha(archive) !== spec.sha256) throw new Error(`SHA-256 Node не совпал; удалите ${archive}`);
const toolchain = join(cache, 'toolchain');
rmSync(toolchain, { recursive: true, force: true });
mkdirSync(toolchain);
execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', toolchain, '--strip-components=1']);
const node = join(toolchain, 'bin/node');
// CI отключает локальный Angular/LMDB cache: артефакт всегда строится заново.
const env = { ...process.env, PATH: `${join(toolchain, 'bin')}:${process.env.PATH}`, NX_DAEMON: 'false', CI: 'true' };
// Сначала pnpm install --frozen-lockfile; не меняем установленное дерево молча.
if (sha(join(root, 'pnpm-lock.yaml')) !== sha(join(root, 'node_modules/.pnpm/lock.yaml'))) {
  throw new Error('Зависимости не соответствуют lockfile: выполните pnpm install --frozen-lockfile');
}
// Убираем также старые assets: удалённая миграция не должна остаться в dist.
rmSync(join(root, 'dist/apps/api'), { recursive: true, force: true });
rmSync(join(root, 'dist/apps/web'), { recursive: true, force: true });
execFileSync('pnpm', ['exec', 'nx', 'run-many', '-t', 'build', '-p', 'web', 'api', '--skip-nx-cache'], { cwd: root, env, stdio: 'inherit' });
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'runtime'), { recursive: true });
cpSync(node, join(out, 'runtime/node'));
cpSync(join(toolchain, 'LICENSE'), join(out, 'runtime/LICENSE'));
mkdirSync(join(out, 'server'));
cpSync(join(root, 'dist/apps/api/main.js'), join(out, 'server/main.js'));
cpSync(join(root, 'dist/apps/api/migrations'), join(out, 'server/migrations'), { recursive: true });
cpSync(join(root, 'dist/apps/web/browser'), join(out, 'web'), { recursive: true });
cpSync(join(root, 'dist/apps/web/3rdpartylicenses.txt'), join(out, 'web/3rdpartylicenses.txt'));
cpSync(join(root, 'certs/russian_trusted_root_ca.pem'), join(out, 'certs/russian_trusted_root_ca.pem'), { recursive: true });
cpSync(join(root, 'scripts/run-with-certs.mjs'), join(out, 'scripts/run-with-certs.mjs'), { recursive: true });
cpSync(join(root, 'scripts/launch-installed.mjs'), join(out, 'launch.mjs'));
writeFileSync(join(out, 'start.sh'), '#!/bin/sh\nset -eu\nRESOURCES=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$RESOURCES/runtime/node" "$RESOURCES/launch.mjs" "$@"\n', { mode: 0o755 });

// Сохраняем изоляцию версий pnpm: каждый реальный пакет имеет собственный
// node_modules со ссылками исключительно внутрь артефакта. Dev-зависимости не копируем.
const copied = new Map();
const manifest = [];
function findPackage(name, from) {
  const req = createRequire(join(from, 'package.json'));
  // Есть npm-пакеты с именем builtin (string_decoder); нужны их package.json.
  for (const dir of req.resolve.paths('__runtime_package__') ?? []) {
    const path = join(dir, name);
    if (existsSync(join(path, 'package.json'))) return realpathSync(path);
  }
}
function link(target, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(relative(dirname(dest), target), dest);
}
function copyPackage(source) {
  if (copied.has(source)) return copied.get(source);
  const pkg = JSON.parse(readFileSync(join(source, 'package.json')));
  const target = join(out, '.packages', String(copied.size), pkg.name);
  copied.set(source, target);
  cpSync(source, target, { recursive: true, filter: (path) => path !== join(source, 'node_modules') });
  manifest.push({ name: pkg.name, version: pkg.version });
  const dependencies = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
  for (const name of Object.keys(dependencies)) {
    if (name.startsWith('@types/')) continue;
    const dependency = findPackage(name, source);
    if (!dependency) {
      if (pkg.optionalDependencies?.[name] || pkg.peerDependenciesMeta?.[name]?.optional) continue;
      throw new Error(`Не найден ${name}, необходимый ${pkg.name}`);
    }
    link(copyPackage(dependency), join(target, 'node_modules', name));
  }
  return target;
}
const bundle = readFileSync(join(out, 'server/main.js'), 'utf8');
const externals = [...new Set([...bundle.matchAll(/module\.exports = require\(["']([^"']+)["']\)/g)].map((match) => match[1]))];
for (const name of externals) {
  if (name.startsWith('node:') || builtinModules.includes(name)) continue;
  const packageName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
  const dest = join(out, 'node_modules', packageName);
  if (existsSync(dest)) continue;
  const source = findPackage(packageName, root);
  if (!source) throw new Error(`Не найден external ${name}`);
  link(copyPackage(source), dest);
}
// Проверка ABI и загрузки .node именно вложенным Node, без NODE_PATH.
execFileSync(join(out, 'runtime/node'), ['-e', `const D=require('better-sqlite3');const db=new D(':memory:');console.log(process.version,process.arch,db.prepare('SELECT 1 AS native_ok').get());db.close()`], { cwd: out, env: { ...env, NODE_PATH: '' }, stdio: 'inherit' });
writeFileSync(join(out, 'build-manifest.json'), JSON.stringify({ node: spec, lockfileSha256: sha(join(root, 'pnpm-lock.yaml')), externals, packages: manifest.sort((a, b) => a.name.localeCompare(b.name)) }, null, 2) + '\n');
console.log(`Автономный сервер: ${out}`);
