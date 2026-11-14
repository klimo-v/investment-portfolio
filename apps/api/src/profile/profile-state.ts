import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  atomicJson,
  canonicalPath,
  hashFile,
  privateDirectory,
  ProfileError,
  syncDirectory,
} from './profile-files';

export const stateKey = (path: string): string =>
  createHash('sha256').update(path).digest('hex').slice(0, 16);
function spellings(path: string): string[] {
  const values = [resolve(path), canonicalPath(path)];
  for (const value of [...values]) {
    if (value.startsWith('/private/var/')) values.push(value.slice('/private'.length));
    else if (value.startsWith('/var/')) values.push('/private' + value);
  }
  return [...new Set(values)];
}
const Required = z.object({ id: z.string(), launchPath: z.string() });
const Pending = z.object({
  stage: z.string(),
  digest: z.string(),
  previousDigest: z.string().nullable(),
  requiredRelease: Required.nullable(),
});
function conflict(): never {
  throw new ProfileError(
    'PROFILE_STATE_CONFLICT',
    'Для одного профиля найдены противоречивые или повреждённые отметки восстановления. Запуск остановлен до изменения базы. Сохраните каталог .profile и обратитесь за проверкой; не удаляйте отметки вручную.',
  );
}
function marker(path: string, pending: boolean): unknown {
  try {
    const input: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const required = (value: z.infer<typeof Required> | null) =>
      value && { id: value.id, launchPath: canonicalPath(value.launchPath) };
    if (!pending) return required(Required.parse(input));
    const value = Pending.parse(input);
    return {
      ...value,
      stage: canonicalPath(value.stage),
      requiredRelease: required(value.requiredRelease),
    };
  } catch {
    return conflict();
  }
}
/** Под обеими блокировками, до resume/миграций. Старые имена становятся ссылками
 * на единое состояние, доступное также сохранённому серверу сборки 3. */
export function reconcileProfileState(dataDir: string, dbPath: string): string {
  const parent = join(canonicalPath(dataDir), '.profile');
  const target = join(parent, stateKey(canonicalPath(dbPath)));
  const sources = [
    ...new Set(spellings(dbPath).map((path) => join(parent, stateKey(path)))),
  ].filter((path) => existsSync(path) && canonicalPath(path) !== canonicalPath(target));
  const directories = [target, ...sources].filter((path) => existsSync(path));
  const agreed = new Map<string, unknown>();
  for (const name of ['required-release.json', 'pending.json']) {
    const values = directories
      .filter((path) => existsSync(join(path, name)))
      .map((path) => marker(join(path, name), name === 'pending.json'));
    if (values.some((value) => JSON.stringify(value) !== JSON.stringify(values[0]))) conflict();
    if (values.length) agreed.set(name, values[0]);
  }
  // Проверка коллизий до записи отметок и изменения базы.
  function check(source: string, destination: string): void {
    if (!existsSync(destination)) return;
    const a = lstatSync(source),
      b = lstatSync(destination);
    if (a.isDirectory() && b.isDirectory()) {
      for (const name of readdirSync(source)) check(join(source, name), join(destination, name));
    } else if (
      canonicalPath(source) !== canonicalPath(destination) &&
      !(
        a.isSymbolicLink() &&
        b.isSymbolicLink() &&
        readlinkSync(source) === readlinkSync(destination)
      ) &&
      !(a.isFile() && b.isFile() && hashFile(source) === hashFile(destination))
    )
      conflict();
  }
  for (const source of sources)
    for (const name of readdirSync(source)) {
      if (!['required-release.json', 'pending.json', 'current-release.json'].includes(name))
        check(join(source, name), join(target, name));
    }
  privateDirectory(target);
  for (const [name, value] of agreed) atomicJson(join(target, name), value);
  function merge(source: string, destination: string): void {
    if (!existsSync(destination))
      cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
    else if (lstatSync(source).isDirectory() && lstatSync(destination).isDirectory())
      for (const name of readdirSync(source)) merge(join(source, name), join(destination, name));
  }
  for (const source of sources) {
    for (const name of readdirSync(source))
      if (!agreed.has(name)) merge(join(source, name), join(target, name));
    renameSync(source, join(parent, `.legacy-${stateKey(source)}-${randomUUID()}`));
    symlinkSync(target, source, 'dir');
    syncDirectory(parent);
  }
  return target;
}
