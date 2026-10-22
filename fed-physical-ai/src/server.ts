import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { ZodError } from 'zod';
import { Authentication } from './platform/auth.js';
import { loadConfig, type PlatformConfig } from './platform/config.js';
import { Controller } from './platform/controller.js';
import { HttpError, type Principal } from './platform/contracts.js';
import { PostgresStore, type Store } from './platform/persistence.js';
import type { ExecutionGateway } from './platform/gateway.js';
import { logger, Metrics, RateLimiter } from './platform/observability.js';

const root = fileURLToPath(new URL('../../dist/', import.meta.url));
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
const securityPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
async function body(req: IncomingMessage): Promise<Buffer> {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
    throw new HttpError(415, 'Use application/json.');
  if (Number(req.headers['content-length']) > 65536) {
    req.resume();
    throw new HttpError(413, 'Request exceeds 64 KiB.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new HttpError(413, 'Request exceeds 64 KiB.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function parse(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}
export interface AppOptions {
  config: PlatformConfig;
  store?: Store;
  authentication?: Authentication;
  gateway?: ExecutionGateway;
  processOutbox?: boolean;
}
export function createApp(options: AppOptions) {
  if (!options?.config) throw new Error('Explicit production configuration is required.');
  const config = options.config;
  if (config.environment !== 'test' && (options.store || options.authentication || options.gateway))
    throw new Error('Runtime service dependencies must use the production adapters.');
  const store =
      options.store ?? new PostgresStore(config.databaseUrl, config.facilityId, config.databaseTls),
    controller = new Controller(store, config, options.gateway),
    authentication = options.authentication ?? new Authentication(config);
  const log = logger(config.logLevel),
    metrics = new Metrics(),
    limiter = new RateLimiter(config.rateLimit),
    ready = controller.initialize();
  ready.catch(() =>
    log({
      level: 'error',
      event: 'startup.failed',
      message: 'Check identity configuration, database schema and controller ownership.',
    }),
  );
  const timer =
    options.processOutbox === false
      ? undefined
      : setInterval(() => {
          void ready.then(() => controller.processOutbox()).catch(() => undefined);
        }, 500);
  timer?.unref();
  const server = createServer(async (req, res) => {
    const requestId = randomUUID(),
      started = performance.now();
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    let principal: Principal | undefined;
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    metrics.requests++;
    res.on('finish', () => {
      const durationMs = performance.now() - started;
      metrics.durationMs += durationMs;
      if (res.statusCode >= 400) metrics.errors++;
      if ([401, 403].includes(res.statusCode)) metrics.denied++;
      log({
        level: res.statusCode >= 500 ? 'error' : 'info',
        event: 'http.request',
        requestId,
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
        actor: principal?.subject ?? 'anonymous',
      });
    });
    try {
      if (!limiter.allow(req.socket.remoteAddress ?? 'unknown')) {
        res.setHeader('Retry-After', '60');
        throw new HttpError(429, 'Request rate exceeded.');
      }
      if (req.method === 'GET' && ['/health/live', '/api/health'].includes(url.pathname))
        return json(200, { status: 'ok', version: '2.0.0' });
      if (req.method === 'GET' && url.pathname === '/health/ready') {
        try {
          await ready;
          await store.read();
          return json(controller.ready ? 200 : 503, { ready: controller.ready });
        } catch {
          return json(503, { ready: false });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/config')
        return json(200, {
          version: '2.0.0',
          facilityId: config.facilityId,
          authentication: 'oidc',
          loginUrl: '/auth/login',
        });
      if (req.method === 'GET' && url.pathname === '/auth/login')
        return await authentication.login(res);
      if (req.method === 'GET' && url.pathname === '/auth/callback')
        return await authentication.callback(req, res, url);
      if (
        url.pathname.startsWith('/api/') ||
        url.pathname === '/metrics' ||
        url.pathname === '/auth/logout'
      ) {
        await ready;
        if (
          req.method === 'POST' &&
          ['/api/device/telemetry', '/api/device/acknowledgements'].includes(url.pathname)
        ) {
          if (req.headers.origin && req.headers.origin !== config.origin)
            throw new HttpError(403, 'Cross-origin device messages are disabled.');
          const id = req.headers['x-device-id'],
            signature = req.headers['x-device-signature'];
          if (typeof id !== 'string' || typeof signature !== 'string')
            throw new HttpError(401, 'Device identity and signature are required.');
          const envelope = controller.verifyDevice(
            await body(req),
            id,
            signature,
            url.pathname.endsWith('acknowledgements'),
          );
          const result = await controller.ingest(envelope, requestId);
          metrics.telemetry++;
          return json(202, result);
        }
        principal = await authentication.authenticate(req);
        if (req.method === 'GET' && url.pathname === '/api/session')
          return json(200, {
            subject: principal.subject,
            name: principal.name,
            roles: principal.roles,
            csrf: principal.csrf ?? null,
          });
        if (req.method === 'GET' && url.pathname === '/api/state')
          return json(200, await controller.state());
        if (req.method === 'GET' && url.pathname === '/api/platform')
          return json(200, await controller.status());
        if (req.method === 'GET' && url.pathname === '/api/audit') {
          const after = Number(url.searchParams.get('after') ?? 0),
            limit = Number(url.searchParams.get('limit') ?? 100);
          if (
            !Number.isSafeInteger(after) ||
            after < 0 ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 1000
          )
            throw new HttpError(400, 'Invalid audit pagination.');
          const records = await store.audit(after, limit);
          return json(200, { records, nextAfter: records.at(-1)?.sequence ?? after });
        }
        if (req.method === 'GET' && url.pathname === '/metrics') {
          const status = await controller.status();
          res.writeHead(200, {
            'Content-Type': 'text/plain; version=0.0.4',
            'Cache-Control': 'no-store',
          });
          res.end(metrics.render(controller.ready, Number(status.revision)));
          return;
        }
        if (req.method !== 'POST' || !['/api/command', '/auth/logout'].includes(url.pathname))
          throw new HttpError(404, 'Unknown API route.');
        authentication.checkMutation(req, principal);
        if (url.pathname === '/auth/logout') return authentication.logout(res);
        return json(
          200,
          await controller.execute(
            parse(await body(req)),
            principal,
            requestId,
            typeof req.headers['idempotency-key'] === 'string'
              ? req.headers['idempotency-key']
              : undefined,
          ),
        );
      }
      if (!['GET', 'HEAD'].includes(req.method ?? ''))
        throw new HttpError(405, 'Method not allowed.');
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        throw new HttpError(400, 'Invalid URL.');
      }
      const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (
        pathname.includes('/.') ||
        !path.startsWith(root.endsWith(sep) ? root : root + sep) ||
        !mime[extname(path)]
      )
        throw new HttpError(404, 'Not found.');
      try {
        const data = await readFile(path);
        res.writeHead(200, {
          'Content-Type': mime[extname(path)],
          'Content-Security-Policy': securityPolicy,
          'Cache-Control': 'no-cache',
        });
        res.end(req.method === 'HEAD' ? undefined : data);
      } catch (e) {
        if (['ENOENT', 'EISDIR'].includes((e as NodeJS.ErrnoException).code ?? ''))
          throw new HttpError(404, 'Not found.');
        throw e;
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof ZodError ? 400 : 503;
      const error =
        e instanceof HttpError
          ? e.message
          : e instanceof ZodError
            ? 'Request does not match the API schema.'
            : 'Service temporarily unavailable.';
      if (!res.headersSent) json(status, { error, requestId });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      if (timer) clearInterval(timer);
      await ready.catch(() => undefined);
      await controller.close();
    })());
  server.on('close', () => {
    void close().catch(() => undefined);
  });
  return { server, ready, controller, store, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let app: ReturnType<typeof createApp> | undefined;
  try {
    const config = loadConfig();
    app = createApp({ config });
    await app.ready;
    app.server.listen(config.port, config.host, () =>
      logger(config.logLevel)({
        level: 'info',
        event: 'server.started',
        origin: config.origin,
        facilityId: config.facilityId,
      }),
    );
    const application = app;
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      application.server.close(() => {
        void application.close().catch(() => {
          process.exitCode = 1;
        });
      });
      setTimeout(() => application.server.closeAllConnections(), 5000).unref();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    app.server.on('error', () => {
      void application.close().finally(() => {
        process.exitCode = 1;
      });
    });
  } catch {
    process.stderr.write(
      'Startup refused. Configure PostgreSQL, organization OIDC, approved safety policy and HTTPS origin; apply schema version 2.\n',
    );
    await app?.close().catch(() => undefined);
    process.exitCode = 1;
  }
}
