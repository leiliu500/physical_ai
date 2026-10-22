import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';

// Serves built static assets only for Playwright. No operational service is emulated here.
const root = fileURLToPath(new URL('../../../dist/', import.meta.url));
const types: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/health/live') {
    res.writeHead(200);
    res.end('ok');
    return;
  }
  if (path.startsWith('/api/')) {
    res.writeHead(path === '/api/config' ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        path === '/api/config' ? { authentication: 'oidc' } : { error: 'Sign in to continue.' },
      ),
    );
    return;
  }
  const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep) || !types[extname(file)]) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    res.writeHead(200, { 'Content-Type': types[extname(file)] });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(4173, '127.0.0.1');
