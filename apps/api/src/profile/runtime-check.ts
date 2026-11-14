import { accessSync, constants, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { ProfileError } from './profile-files';

/** Проверяем поставку на отдельной копии парной БД, не касаясь рабочего профиля. */
export async function validateRuntime(resources: string, database: string): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), 'portfolio-runtime-check-'));
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  try {
    const launcher = join(resources, 'start.sh');
    accessSync(launcher, constants.X_OK);
    accessSync(join(resources, 'runtime/node'), constants.X_OK);
    accessSync(join(resources, 'launch.mjs'), constants.R_OK);
    accessSync(join(resources, 'scripts/run-with-certs.mjs'), constants.R_OK);
    accessSync(join(resources, 'certs/russian_trusted_root_ca.pem'), constants.R_OK);
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const address = socket.address();
    if (!address || typeof address === 'string') throw new Error();
    const port = address.port;
    await new Promise<void>((done) => socket.close(() => done()));
    const env = { HOME: temporary, PATH: '/usr/bin:/bin', DATA_DIR: join(temporary, 'data'), PORT: String(port) };
    mkdirSync(env.DATA_DIR);
    copyFileSync(database, join(env.DATA_DIR, 'portfolio.sqlite'));
    child = spawn(launcher, [], { cwd: temporary, env, stdio: 'ignore' });
    exited = once(child, 'exit');
    // Обрабатываем ошибку spawn, не допуская необработанного rejection до finally.
    void exited.catch(() => {});
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null || child.signalCode) throw new Error();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok && (await response.json() as { spa?: boolean }).spa === true) return;
      } catch { /* Ждём готовности, не выводя внутренние ошибки и настройки. */ }
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error();
  } catch {
    throw new ProfileError('RECOVERY_DAMAGED', 'Сохранённый runtime не проходит проверку запуска. Рабочая база сохранена.');
  } finally {
    if (child && exited && child.exitCode === null && !child.signalCode) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child?.kill('SIGKILL'), 5000);
      try { await exited; } catch { /* Ошибка запуска уже обработана выше. */ }
      finally { clearTimeout(timer); }
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}
