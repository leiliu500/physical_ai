import { cp, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openapi } from '../src/platform/openapi.js';
const root = new URL('../../', import.meta.url);
await cp(new URL('src/ai/prompts/', root), new URL('build/src/ai/prompts/', root), {
  recursive: true,
});
await mkdir(new URL('dist/', root), { recursive: true });
await cp(new URL('public/', root), new URL('dist/', root), { recursive: true });
await cp(new URL('build/src/client/', root), new URL('dist/client/', root), { recursive: true });
await writeFile(new URL('dist/openapi.json', root), JSON.stringify(openapi, null, 2));
console.log('Built production operations console: ' + fileURLToPath(new URL('dist/', root)));
