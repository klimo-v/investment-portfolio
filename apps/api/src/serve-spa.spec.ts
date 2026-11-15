import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serveSpa } from './serve-spa';
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, {recursive:true,force:true}); });
describe('Публикация SPA на работающем сервере', () => {
  it('A → неполная B → B: транзитивные зависимости, старая вкладка, MIME и 404', async () => {
    const root = mkdtempSync(join(tmpdir(),'spa-')); dirs.push(root);
    vi.stubEnv('STATIC_ROOT', root);
    const put = (path: string, content: string) => writeFileSync(join(root,path),content);
    put('index.html','<base href="/"><link href="a.css" rel="stylesheet"><script type="module" src="a.js"></script>');
    put('a.js', 'export const A=1; import("./lazy-a.js")'); put('lazy-a.js','export const page="A"'); put('a.css','body{color:red}');
    const server = new FastifyAdapter().getInstance(); server.get('/api/health',()=>({ok:true}));
    serveSpa({getHttpAdapter:()=>({getInstance:()=>server})} as unknown as NestFastifyApplication);
    const get = (path: string) => server.inject({method:'GET',url:path});
    try {
      const a = await get('/dashboard');
      expect(a.statusCode).toBe(200); expect(a.headers['content-type']).toContain('text/html');
      const oldPrefix = /src="(\/_spa\/[^/]+)\/a.js/.exec(a.body)?.[1] as string;
      expect((await get(oldPrefix+'/a.js')).body).toContain('export const A=1');
      put('index.html','<link href="b.css"><script type="module" src="b.js"></script>');
      put('b.js','import("./lazy-b.js"); export const B=2;'); put('b.css','body{color:blue}');
      expect((await get('/dashboard')).body).toBe(a.body);
      put('lazy-b.js','export const page="B"');
      const b = await get('/dashboard'); expect(b.body).not.toBe(a.body);
      const prefix = /src="(\/_spa\/[^/]+)\/b.js/.exec(b.body)?.[1] as string;
      expect((await get(prefix+'/b.js')).headers['content-type']).toContain('text/javascript');
      expect((await get(prefix+'/lazy-b.js')).body).toContain('"B"');
      const css = await get(prefix+'/b.css'); expect(css.headers['content-type']).toContain('text/css'); expect(css.body).toBe('body{color:blue}');
      rmSync(join(root,'lazy-a.js')); expect((await get(oldPrefix+'/lazy-a.js')).body).toContain('"A"');
      expect((await get('/operations')).body).toBe(b.body);
      expect((await get('/api/health')).json()).toEqual({ok:true});
      for(const path of ['/absent.js','/api/unknown',prefix+'/absent.css']) expect((await get(path)).statusCode).toBe(404);
    } finally { await server.close(); }
  });
});
