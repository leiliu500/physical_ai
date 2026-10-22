import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../out/', import.meta.url));
const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep) || !mime[extname(file)]) {
    response.writeHead(404);
    response.end();
    return;
  }
  try {
    const data = await readFile(file);
    response.writeHead(200, {
      'Content-Type': mime[extname(file)],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
}).listen(4174, '127.0.0.1', () => console.log('Simulation preview: http://127.0.0.1:4174'));
