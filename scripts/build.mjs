import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';

await build({
  entryPoints: ['src/main.ts', 'src/preload.ts'], outdir: 'dist',
  platform: 'node', format: 'cjs', bundle: true, external: ['electron'],
});
await build({
  entryPoints: ['src/inbox.tsx'], outfile: 'dist/inbox.js',
  platform: 'browser', bundle: true, minify: true, define: { 'process.env.NODE_ENV': '"production"' },
});
await copyFile('src/index.html', 'dist/index.html');
