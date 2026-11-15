import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, posix } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { fromAppRoot } from './app-paths';

export function resolveStaticRoot(): string {
  return fromAppRoot(process.env['STATIC_ROOT'] ?? 'dist/apps/web/browser');
}

interface SpaSnapshot {
  id: string;
  manifest: string | null;
  files: Map<string, Buffer>;
  html: string;
}
const hash = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
const localPath = (url: string, base = '/') => {
  const parsed = new URL(url, `http://spa.local${base}`);
  return parsed.origin === 'http://spa.local' ? decodeURIComponent(parsed.pathname).slice(1) : null;
};

/** Снимок целой версии: включая ленивые чанки, стили и ресурсы. */
function snapshot(root: string): SpaSnapshot {
  const manifestPath = join(root, 'spa-manifest.json');
  const manifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null;
  const files = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && !path.endsWith('.map') && path !== 'spa-manifest.json') {
        files.set(path, readFileSync(join(root, path)));
      }
    }
  };
  walk('');
  if (manifest) {
    const expected: Record<string, string> = JSON.parse(manifest);
    for (const [path, digest] of Object.entries(expected)) {
      if (!files.has(path) || hash(files.get(path) as Buffer) !== digest) throw new Error(`Неполная сборка SPA: ${path}`);
    }
    if (readFileSync(manifestPath, 'utf8') !== manifest) throw new Error('Сборка SPA меняется');
  }
  const index = files.get('index.html')?.toString('utf8');
  if (!index) throw new Error('Нет index.html SPA');
  const requireFile = (url: string, base = '/') => {
    const path = localPath(url, base);
    if (path !== null && !files.has(path)) throw new Error(`Недоступен файл SPA: ${path}`);
  };
  for (const tag of index.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    for (const attr of tag[0].matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
      if (/\.(?:js|css)(?:[?#]|$)/i.test(attr[2])) requireFile(attr[2]);
    }
  }
  // Проверяем и транзитивные импорты, в том числе ленивые страницы Angular.
  for (const [path, body] of files) {
    if (path.endsWith('.js')) {
      for (const match of body.toString().matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
        if (match[1].startsWith('.') || match[1].startsWith('/')) requireFile(match[1], `/${path}`);
      }
    }
    if (path.endsWith('.css')) {
      for (const match of body.toString().matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) {
        requireFile(match[1], `/${path}`);
      }
    }
  }
  const id = hash([...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, body]) => `${path}:${hash(body)}`).join('\n'));
  // base href остаётся '/', Angular-маршруты не меняются. Относительные импорты
  // JS и url() CSS автоматически остаются в пространстве этой версии.
  const html = index.replace(/(<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["'])([^"']+)(["'])/gi,
    (all, prefix: string, url: string, suffix: string) => {
      const path = localPath(url);
      return path !== null && files.has(path) ? `${prefix}/_spa/${id}/${path}${suffix}` : all;
    });
  return { id, manifest, files, html };
}

export function assertSpaReady(): void {
  snapshot(resolveStaticRoot());
}

const mime: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.webp': 'image/webp',
};

/** Живой процесс публикует только готовые версии; открытые вкладки сохраняют свои чанки. */
export function serveSpa(app: NestFastifyApplication): boolean {
  const root = resolveStaticRoot();
  if (!existsSync(join(root, 'index.html'))) return false;
  let current = snapshot(root);
  const versions = new Map([[current.id, current]]);
  const refresh = () => {
    try {
      if (current.manifest && readFileSync(join(root, 'spa-manifest.json'), 'utf8') === current.manifest) return;
      const candidate = snapshot(root);
      versions.set(candidate.id, candidate);
      current = candidate;
    } catch {
      // Во время сборки/переключения либо при повреждении файлов остаётся целая
      // предыдущая версия. Файлы снимка не зависят от удаления старого dist.
    }
  };
  app.getHttpAdapter().getInstance().get('/*', (request, reply) => {
    const pathname = new URL(request.url, 'http://spa.local').pathname;
    const notFound = () => reply.status(404).send({ statusCode: 404, message: 'Not Found' });
    if (pathname === '/api' || pathname.startsWith('/api/')) return notFound();
    let path: string;
    try { path = decodeURIComponent(pathname).slice(1); } catch { return notFound(); }
    reply.header('X-Content-Type-Options', 'nosniff');
    const version = /^_spa\/([a-f0-9]{64})\/(.+)$/.exec(path);
    if (version || extname(path) && path !== 'index.html') {
      const file = version ? versions.get(version[1])?.files.get(version[2]) : current.files.get(path);
      if (!file) return notFound();
      reply.header('Cache-Control', version ? 'public, max-age=31536000, immutable' : 'no-cache');
      return reply.type(mime[extname(version ? version[2] : path)] ?? 'application/octet-stream').send(file);
    }
    refresh();
    return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(current.html);
  });
  return true;
}
