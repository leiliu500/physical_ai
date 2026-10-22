import { lstat, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';

const root = new URL('../../', import.meta.url);
const inputs = [
  'Dockerfile',
  'Dockerfile.simulation',
  '.dockerignore',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'playwright.config.ts',
  'src',
  'scripts',
  'public',
  'tests',
  'e2e',
  'migrations',
];
const entries: Record<string, Uint8Array> = {};
let size = 0;
async function add(name: string): Promise<void> {
  const path = new URL(name, root);
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error('Build input must not contain symbolic links.');
  if (stat.isDirectory()) {
    for (const child of (await readdir(path)).sort()) {
      if (child.startsWith('.') || /^(node_modules|build|dist|out)$/.test(child))
        throw new Error('Build input contains a disallowed nested path.');
      await add(`${name}/${child}`);
    }
  } else if (stat.isFile()) {
    size += stat.size;
    if (size > 25 * 1024 * 1024) throw new Error('Source archive exceeds 25 MiB.');
    entries[name] = await readFile(path);
  } else throw new Error('Build inputs must be ordinary files or directories.');
}
for (const name of inputs) await add(name);
const archive = zipSync(entries, { level: 6, mtime: new Date(1980, 0, 1) });
const directory = new URL('.openai/local/aws-build/', root);
await mkdir(directory, { recursive: true });
const path = new URL('source.zip', directory);
await writeFile(path, archive);
console.log(
  JSON.stringify({
    archive: fileURLToPath(path),
    sha256: createHash('sha256').update(archive).digest('hex'),
    files: Object.keys(entries).length,
  }),
);
