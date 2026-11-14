import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const root = resolve(import.meta.dirname, '../..');
const run = (name, args, options = {}) => execFileSync(name, args, { stdio: 'inherit', ...options });
export const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const escapeXML = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function packageApp({ version, build = '1', channel = 'release', runtimeSource, outputDirectory, identity = '-', notarizeProfile }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^\d+(\.\d+){0,2}$/.test(build)) throw Error('Версия: X.Y.Z; номер сборки: число или X.Y.Z');
  if (notarizeProfile && identity === '-') throw Error('Для нотарификации нужен MAC_SIGN_IDENTITY (Developer ID Application)');
  const destination = resolve(outputDirectory ?? join(root, 'dist/releases', `${version}-${build}`));
  mkdirSync(destination, { recursive: true });
  const app = join(destination, 'Investment Portfolio.app');
  const staging = join(destination, '.dmg-root');
  const dmg = join(destination, `Investment-Portfolio-${version}-arm64.dmg`);
  rmSync(join(destination, 'release.json'), { force: true });
  rmSync(join(destination, 'notary-result.json'), { force: true });
  rmSync(app, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true }); rmSync(dmg, { force: true });
  const contents = join(app, 'Contents'); const resources = join(contents, 'Resources');
  mkdirSync(join(contents, 'MacOS'), { recursive: true }); mkdirSync(resources);
  cpSync(runtimeSource, join(resources, 'Runtime'), { recursive: true, verbatimSymlinks: true });
  const runtime = join(resources, 'Runtime');
  const manifestPath = join(runtime, 'build-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath));
  Object.assign(manifest, { application: { version, build, channel, bundleId: 'com.krisfeminova.investment-portfolio', minimumMacOS: '13.0' } });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const info = { CFBundleExecutable: 'InvestmentPortfolio', CFBundleIdentifier: 'com.krisfeminova.investment-portfolio', CFBundleName: 'Investment Portfolio', CFBundleDisplayName: 'Investment Portfolio', CFBundlePackageType: 'APPL', CFBundleShortVersionString: version, CFBundleVersion: build, LSMinimumSystemVersion: '13.0', NSHighResolutionCapable: true, LSUIElement: true, PortfolioBuildChannel: channel, NSHumanReadableCopyright: 'Investment Portfolio' };
  writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${Object.entries(info).map(([key, value]) => `<key>${key}</key>${typeof value === 'boolean' ? `<${value}/>` : `<string>${escapeXML(value)}</string>`}`).join('\n')}</dict></plist>\n`);
  run('/usr/bin/xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', 'arm64-apple-macos13.0', '-module-cache-path', join(root, 'tmp/mac-runtime/swift-cache'), '-framework', 'Cocoa', '-framework', 'ServiceManagement', join(root, 'apps/macos/main.swift'), '-o', join(contents, 'MacOS/InvestmentPortfolio')]);
  // Подписываем изнутри наружу; --deep не используется для создания подписи.
  const mach = [];
  function visit(dir) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry); const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) {
        const magic = readFileSync(path).subarray(0, 4).toString('hex');
        if (['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca', 'feedfacf'].includes(magic)) mach.push(path);
      }
    }
  }
  visit(runtime);
  const signing = ['--force', '--sign', identity, '--options', 'runtime', ...(identity === '-' ? ['--timestamp=none'] : ['--timestamp'])];
  // У ad hoc нет Team ID, поэтому только локальному Node разрешаем загрузку
  // ad hoc SQLite. Developer ID сохраняет library validation и единый Team ID.
  for (const path of mach) run('/usr/bin/codesign', [...signing, ...(path === join(runtime, 'runtime/node') ? ['--entitlements', join(root, identity === '-' ? 'apps/macos/node-local-entitlements.plist' : 'apps/macos/node-entitlements.plist')] : []), path]);
  run('/usr/bin/codesign', [...signing, app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  // Проверяем уже подписанный Node с нативной SQLite-библиотекой.
  run(join(runtime, 'runtime/node'), ['-e', "const D=require('better-sqlite3');const d=new D(':memory:');console.log(d.prepare('SELECT 1 AS signed_runtime_ok').get());d.close()"], { cwd: runtime, env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin' } });
  mkdirSync(staging); cpSync(app, join(staging, 'Investment Portfolio.app'), { recursive: true, verbatimSymlinks: true });
  symlinkSync('/Applications', join(staging, 'Applications'));
  writeFileSync(join(staging, 'Установка.txt'), `Investment Portfolio ${version} (${build}) — ${channel}\n\nПеренесите Investment Portfolio.app в «Программы».\nОбновление: выберите «Выйти» в меню старой версии, замените .app и запустите новую.\nПрофиль хранится отдельно от приложения.\n${identity === '-' ? 'Локальная тестовая сборка: подпись ad hoc, без нотарификации Apple.\n' : ''}`);
  try {
    run('/usr/bin/hdiutil', ['create', '-volname', `Investment Portfolio ${version}`, '-srcfolder', staging, '-format', 'UDZO', '-fs', 'HFS+', '-ov', dmg]);
    if (identity !== '-') run('/usr/bin/codesign', ['--sign', identity, '--timestamp', dmg]);
    if (notarizeProfile) {
      const response = JSON.parse(execFileSync('/usr/bin/xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', notarizeProfile, '--wait', '--output-format', 'json'], { encoding: 'utf8' }));
      writeFileSync(join(destination, 'notary-result.json'), JSON.stringify(response, null, 2));
      if (response.status !== 'Accepted') throw Error(`Нотарификация: ${response.status}; запрос ${response.id}`);
      run('/usr/bin/xcrun', ['stapler', 'staple', app]);
      run('/usr/bin/xcrun', ['stapler', 'staple', dmg]);
      run('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
      run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg]);
    }
  } finally { rmSync(staging, { recursive: true, force: true }); }
  const result = { version, build, channel, app, dmg, dmgSha256: hash(dmg), signing: identity === '-' ? 'ad-hoc hardened runtime' : identity, notarized: Boolean(notarizeProfile), serverSha256: hash(join(runtime, 'server/main.js')), webSha256: hash(join(runtime, 'web/index.html')) };
  writeFileSync(join(destination, 'release.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2)); return result;
}
