import { cp, mkdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, 'out');
if ((await lstat(output).catch(() => undefined))?.isSymbolicLink())
  throw new Error('Simulation output must not be a link.');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(root, 'dist'), output, { recursive: true });
const index = (await readFile(resolve(output, 'index.html'), 'utf8'))
  .replace('<body>', '<body data-runtime="simulation">')
  .replace(
    '<title>Reserve | Physical AI Operations</title>',
    '<title>Reserve | Physical AI Simulation</title>',
  );
await writeFile(resolve(output, 'index.html'), index);
await build({
  absWorkingDir: root,
  entryPoints: ['src/simulation/browser.ts'],
  outfile: 'out/simulation/browser.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'eof',
  inject: ['src/simulation/browser-globals.ts'],
  alias: { 'node:crypto': resolve(root, 'src/simulation/browser-crypto.ts') },
  metafile: true,
}).then(async (result) => {
  if (Object.keys(result.metafile!.inputs).some((name) => /node_modules\/(pg|jose)\//.test(name)))
    throw new Error('Simulation bundle unexpectedly includes production service adapters.');
});
console.log('Built isolated browser simulation in out/. Production assets remain in dist/.');
