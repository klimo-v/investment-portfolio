import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { packageApp, root } from './lib/mac-package.mjs';
const args = process.argv.slice(2);
const version = args.shift();
const option = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw Error('Использование: pnpm release:mac X.Y.Z [--build N] [--local-test]');
if (args.some((value, index) => !['--build', '--local-test'].includes(value) && args[index - 1] !== '--build')) throw Error('Неизвестный аргумент');
// Единственная публичная команда всегда пересобирает текущие исходники.
execFileSync(process.execPath, [join(root, 'scripts/build-mac-runtime.mjs')], { cwd: root, stdio: 'inherit' });
packageApp({ version, build: option('--build') ?? '1', channel: args.includes('--local-test') ? 'local-test' : 'release', runtimeSource: join(root, 'dist/mac-arm64'), identity: process.env.MAC_SIGN_IDENTITY ?? '-', notarizeProfile: process.env.MAC_NOTARY_PROFILE });
