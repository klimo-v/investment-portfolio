import { FastifyAdapter } from '@nestjs/platform-fastify';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PortfolioBackup } from '../db/portfolio-backup';
import { applyMigrations } from '../db/apply-migrations';
import { dataGate } from './data-gate';
import { registerDataHttp, trustedSource } from './data-http';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  dataGate.active = 0;
  while (cleanups.length) await cleanups.pop()?.();
});
const migrations = join(__dirname, '../db/migrations');
async function setup(beforeClearParsing?: () => Promise<void>) {
  const backups = new PortfolioBackup(migrations);
  const temporary = backups.temporary();
  cleanups.push(temporary.dispose);
  const db = new Database(temporary.file);
  cleanups.push(() => db.close());
  applyMigrations(db, migrations);
  db.exec("INSERT INTO systems(id,name) VALUES ('original','Original')");
  const server = new FastifyAdapter().getInstance();
  if (beforeClearParsing) server.addHook('preParsing', async (request, _reply, payload) => {
    if (request.url === '/api/data/clear') await beforeClearParsing();
    return payload;
  });
  cleanups.push(() => server.close());
  await registerDataHttp(server, db, migrations);
  await server.ready();
  const headers = { origin: 'http://localhost:80', 'x-portfolio-generation': dataGate.generation };
  return { server, db, backups, temporary, headers };
}
it('две вкладки: восстановление между onRequest и очисткой отклоняет старое подтверждение', async () => {
  let entered!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((done) => { entered = done; });
  const resumed = new Promise<void>((done) => { release = done; });
  const { server, db, headers } = await setup(async () => { entered(); await resumed; });
  const snapshot = await server.inject({ method: 'GET', url: '/api/data/backup' });
  const preview = await server.inject({ method: 'POST', url: '/api/data/preview', headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: snapshot.rawPayload });
  const staleClear = server.inject({ method: 'POST', url: '/api/data/clear', headers, payload: { confirmation: 'DELETE ALL' } }).then((response) => response);
  try {
    await arrived;
    const restored = await server.inject({ method: 'POST', url: '/api/data/restore', headers, payload: { id: preview.json().id, confirmation: 'REPLACE' } });
    expect(restored.statusCode).toBe(200);
  } finally { release(); }
  expect((await staleClear).statusCode).toBe(409);
  expect(db.prepare('SELECT id FROM systems').all()).toEqual([{ id: 'original' }]);
});
it('HTTP: download → preview → cancel; origin, подтверждение, занятость, очистка, restore и старое поколение', async () => {
  const { server, db, headers } = await setup();
  const snapshot = await server.inject({ method: 'GET', url: '/api/data/backup' });
  expect(snapshot.statusCode).toBe(200);
  expect(snapshot.headers['content-disposition']).toMatch(/portfolio-.*\.sqlite/);
  const upload = () =>
    server.inject({
      method: 'POST',
      url: '/api/data/preview',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: snapshot.rawPayload,
    });
  const cancelled = await upload();
  expect(cancelled.statusCode).toBe(200);
  expect(cancelled.json().systems).toBe(1);
  await server.inject({
    method: 'DELETE',
    url: `/api/data/preview/${cancelled.json().id}`,
    headers,
  });
  expect(db.prepare('SELECT count(*) AS n FROM systems').get()).toEqual({ n: 1 });
  const candidate = await upload();
  expect(candidate.statusCode).toBe(200);
  const restore = () =>
    server.inject({
      method: 'POST',
      url: '/api/data/restore',
      headers,
      payload: { id: candidate.json().id, confirmation: 'REPLACE' },
    });
  const clear = (customHeaders = headers, confirmation = 'DELETE ALL') =>
    server.inject({
      method: 'POST',
      url: '/api/data/clear',
      headers: customHeaders,
      payload: { confirmation },
    });
  expect((await clear({ ...headers, origin: 'https://evil.test' })).statusCode).toBe(403);
  expect(
    (await clear({ 'x-portfolio-generation': dataGate.generation } as typeof headers)).statusCode,
  ).toBe(403);
  expect((await clear(headers, 'no')).statusCode).toBe(400);
  dataGate.active++;
  expect((await restore()).statusCode).toBe(409);
  expect((await clear()).statusCode).toBe(409);
  dataGate.active--;
  db.exec("INSERT INTO systems(id,name) VALUES ('other','Other')");
  expect((await restore()).statusCode).toBe(200);
  expect(db.prepare('SELECT id FROM systems').all()).toEqual([{ id: 'original' }]);
  expect((await clear()).statusCode).toBe(409);
  headers['x-portfolio-generation'] = dataGate.generation;
  expect((await clear()).statusCode).toBe(200);
  expect(db.prepare('SELECT * FROM systems').all()).toEqual([]);
  // Старое подтверждение нельзя повторно применить.
  headers['x-portfolio-generation'] = dataGate.generation;
  expect((await restore()).statusCode).toBe(400);
});
it('потоковая загрузка валидной базы больше общего JSON-лимита 25 МиБ; повреждённый файл', async () => {
  const { server, db, backups, temporary, headers } = await setup();
  db.prepare('UPDATE systems SET name=?').run('x'.repeat(26 * 1024 * 1024));
  const file = join(temporary.directory, 'large.sqlite');
  await backups.backup(db, file);
  const payload = readFileSync(file);
  expect(payload.length).toBeGreaterThan(25 * 1024 * 1024);
  const large = await server.inject({
    method: 'POST',
    url: '/api/data/preview',
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    payload,
  });
  expect(large.statusCode, large.body).toBe(200);
  const broken = await server.inject({
    method: 'POST',
    url: '/api/data/preview',
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    payload: Buffer.from('not SQLite'),
  });
  expect(broken.statusCode).toBe(400);
  expect(broken.json().message).toMatch(/повреждён/);
});
it('источник production/dev без доверия к forwarded host', () => {
  const original = process.env['NODE_ENV'];
  try {
    process.env['NODE_ENV'] = 'production';
    expect(
      trustedSource({
        protocol: 'http',
        headers: { host: 'localhost:3000', origin: 'http://localhost:4200' },
      }),
    ).toBe(false);
    expect(
      trustedSource({
        protocol: 'https',
        headers: { host: 'portfolio.local', origin: 'https://portfolio.local' },
      }),
    ).toBe(true);
    expect(
      trustedSource({
        protocol: 'http',
        headers: {
          host: 'localhost:3000',
          origin: 'https://evil.test',
          'x-forwarded-host': 'evil.test',
        },
      }),
    ).toBe(false);
    process.env['NODE_ENV'] = 'development';
    expect(
      trustedSource({
        protocol: 'http',
        headers: { host: 'localhost:3000', origin: 'http://localhost:4200' },
      }),
    ).toBe(true);
  } finally {
    if (original === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = original;
  }
});
