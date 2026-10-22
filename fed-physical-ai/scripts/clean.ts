import { lstat, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only remove fixed generated directories within this project.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['build', 'dist', 'out']) {
  const target = resolve(root, name);
  if (dirname(target) !== root) throw new Error('Invalid build output path.');
  const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (entry?.isSymbolicLink()) throw new Error('Build output cannot be a symbolic link.');
  await rm(target, { recursive: true, force: true });
}
