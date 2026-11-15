// Сборка вне рабочего каталога раздачи; публикация только после успеха Angular.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
const output = resolve('dist/apps/web');
mkdirSync('dist/apps', {recursive:true});
const staging = mkdtempSync(resolve('dist/apps/.web-build-'));
const previous = `${staging}-previous`;
let published = false;
try {
  const result = spawnSync(process.execPath, ['node_modules/nx/dist/bin/nx.js', 'run', `web:bundle:${process.argv[2] ?? 'production'}`, `--outputPath=${staging}`], {stdio:'inherit'});
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    const root = join(staging,'browser');
    const manifest = {};
    function walk(dir='') {
      for(const entry of readdirSync(join(root,dir),{withFileTypes:true})) {
        const path = join(dir,entry.name);
        if(entry.isDirectory()) walk(path);
        else if(!path.endsWith('.map')) manifest[path] = createHash('sha256').update(readFileSync(join(root,path))).digest('hex');
      }
    }
    walk();
    writeFileSync(join(root,'spa-manifest.json'),JSON.stringify(manifest));
    if(existsSync(output)) renameSync(output,previous);
    try { renameSync(staging,output); published = true; }
    catch(error) { if(existsSync(previous)) renameSync(previous,output); throw error; }
  }
} finally {
  rmSync(staging,{recursive:true,force:true});
  if (published) rmSync(previous,{recursive:true,force:true});
}
