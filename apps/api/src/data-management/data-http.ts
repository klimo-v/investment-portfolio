import { createReadStream, createWriteStream } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from './fastify-types';
import { PortfolioBackup } from '../db/portfolio-backup';
import type Database from 'better-sqlite3';
import { dataGate } from './data-gate';

export const BACKUP_UPLOAD_LIMIT = 512 * 1024 * 1024;

/** Без доверия к X-Forwarded-Host; dev-origin разрешён только явно вне production. */
export function trustedSource(request: Pick<FastifyRequest, 'headers' | 'protocol'>): boolean {
  const origin = request.headers.origin;
  if (!origin || origin === 'null' || request.headers['sec-fetch-site'] === 'cross-site')
    return false;
  const same = `${request.protocol}://${request.headers.host}`;
  const dev =
    process.env['NODE_ENV'] !== 'production' && process.env['APP_INSTALLED'] !== '1'
      ? (process.env['CORS_ORIGIN'] ?? 'http://localhost:4200')
      : undefined;
  return origin === same || origin === dev;
}

export async function registerDataHttp(
  server: FastifyInstance,
  sqlite: Database.Database,
  migrationsFolder: string,
): Promise<void> {
  const backups = new PortfolioBackup(migrationsFolder);
  const pending = new Map<
    string,
    { temporary: ReturnType<PortfolioBackup['temporary']>; expires: number; generation: string }
  >();
  let preparing = false;
  const sweep = (): void => {
    for (const [id, value] of pending)
      if (value.expires < Date.now()) {
        value.temporary.dispose();
        pending.delete(id);
      }
  };
  const timer = setInterval(sweep, 60_000);
  timer.unref();
  server.addHook('onClose', async () => {
    clearInterval(timer);
    for (const value of pending.values()) value.temporary.dispose();
    pending.clear();
  });
  server.get('/api/data/status', async (_request, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .send({ generation: dataGate.generation, uploadLimit: BACKUP_UPLOAD_LIMIT }),
  );
  server.get('/api/data/backup', async (_request, reply) => {
    const temporary = backups.temporary();
    dataGate.active++;
    try {
      await backups.backup(sqlite, temporary.file);
      const stamp = new Date();
      const pad = (n: number): string => String(n).padStart(2, '0');
      const filename = `portfolio-${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.sqlite`;
      const stream = createReadStream(temporary.file);
      stream.once('close', temporary.dispose);
      return reply
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Cache-Control', 'no-store')
        .type('application/octet-stream')
        .send(stream);
    } catch {
      temporary.dispose();
      return reply.code(500).send({ message: 'Не удалось создать резервную копию.' });
    } finally {
      dataGate.active--;
    }
  });
  // Отдельный parser возвращает поток: не base64 и не общий JSON-лимит 25 МиБ.
  server.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
      done(null, payload),
    );
    scope.addHook('onRequest', async (request, reply) => {
      if (!trustedSource(request))
        return reply.code(403).send({ message: 'Источник запроса не разрешён.' });
      if (request.headers['x-portfolio-generation'] !== dataGate.generation) {
        return reply.code(409).send({ message: 'Данные изменились. Обновите страницу.' });
      }
      reply.header('Cache-Control', 'no-store');
    });
    scope.post('/api/data/preview', { bodyLimit: BACKUP_UPLOAD_LIMIT }, async (request, reply) => {
      sweep();
      if (preparing || pending.size >= 3)
        return reply
          .code(409)
          .send({ message: 'Завершите или отмените предыдущее восстановление.' });
      preparing = true;
      const temporary = backups.temporary();
      const generation = dataGate.generation;
      try {
        if (request.headers['content-type'] !== 'application/octet-stream')
          throw new Error('Выберите файл SQLite.');
        let received = 0;
        const limit = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            callback(
              received > BACKUP_UPLOAD_LIMIT ? new Error('Файл превышает лимит 512 МиБ.') : null,
              chunk,
            );
          },
        });
        await pipeline(
          request.body as Readable,
          limit,
          createWriteStream(temporary.file, { mode: 0o600 }),
        );
        await chmod(temporary.file, 0o600);
        const summary = backups.prepare(temporary.file);
        if (generation !== dataGate.generation)
          throw new Error('Данные изменились. Загрузите файл заново.');
        const id = randomUUID();
        pending.set(id, { temporary, generation, expires: Date.now() + 15 * 60_000 });
        return { id, ...summary };
      } catch (error) {
        temporary.dispose();
        return reply
          .code(400)
          .send({ message: error instanceof Error ? error.message : 'Не удалось проверить файл.' });
      } finally {
        preparing = false;
      }
    });
    scope.delete('/api/data/preview/:id', async (request) => {
      const id = (request.params as { id: string }).id;
      pending.get(id)?.temporary.dispose();
      pending.delete(id);
      return { cancelled: true };
    });
    scope.post('/api/data/restore', async (request, reply) => {
      const body = request.body as { id?: string; confirmation?: string } | null;
      const candidate = body?.id ? pending.get(body.id) : undefined;
      if (
        !candidate ||
        candidate.expires < Date.now() ||
        candidate.generation !== dataGate.generation ||
        body?.confirmation !== 'REPLACE'
      ) {
        return reply.code(400).send({ message: 'Подтверждение устарело. Выберите файл повторно.' });
      }
      try {
        dataGate.assertIdle();
        backups.replace(sqlite, candidate.temporary.file);
        dataGate.changed();
        for (const value of pending.values()) value.temporary.dispose();
        pending.clear();
        return { generation: dataGate.generation };
      } catch (error) {
        return reply
          .code(409)
          .send({
            message: error instanceof Error ? error.message : 'Восстановление не выполнено.',
          });
      }
    });
    scope.post('/api/data/clear', async (request, reply) => {
      // Между onRequest и handler тело читается асинхронно; другая вкладка
      // могла уже заменить портфель. Далее до changed() нет ни одного await.
      if (request.headers['x-portfolio-generation'] !== dataGate.generation)
        return reply.code(409).send({ message: 'Данные изменились. Обновите страницу.' });
      if ((request.body as { confirmation?: string } | null)?.confirmation !== 'DELETE ALL') {
        return reply.code(400).send({ message: 'Необходимо явное подтверждение удаления.' });
      }
      try {
        dataGate.assertIdle();
        backups.clear(sqlite);
        dataGate.changed();
        for (const value of pending.values()) value.temporary.dispose();
        pending.clear();
        return { generation: dataGate.generation };
      } catch (error) {
        return reply
          .code(409)
          .send({ message: error instanceof Error ? error.message : 'Удаление не выполнено.' });
      }
    });
  });
}
