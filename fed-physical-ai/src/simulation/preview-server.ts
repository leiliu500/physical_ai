import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { BedrockAdvisor, bedrockSettings, type Advisor } from '../ai/bedrock.js';
import { contextSchema, planRequestSchema } from '../ai/contracts.js';
import { HttpError } from '../platform/contracts.js';
import { RateLimiter } from '../platform/observability.js';

export function createSimulationPreview(
  advisor?: Advisor,
  options: { publicOrigin?: string } = {},
) {
  const publicUrl = options.publicOrigin ? new URL(options.publicOrigin) : undefined;
  if (
    publicUrl &&
    (!['http:', 'https:'].includes(publicUrl.protocol) ||
      publicUrl.username ||
      publicUrl.password ||
      publicUrl.pathname !== '/' ||
      publicUrl.search ||
      publicUrl.hash)
  )
    throw new Error(
      'Simulation public origin must be an HTTP(S) origin without credentials, path, query or fragment.',
    );
  const root = fileURLToPath(new URL('../../../out/', import.meta.url));
  const mime: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
  };
  const service = advisor ?? new BedrockAdvisor(bedrockSettings());
  const rate = new RateLimiter(6);
  let active = 0;
  return createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const json = (status: number, value: unknown) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(JSON.stringify(value));
    };
    if (path === '/health/live' && request.method === 'GET')
      return json(200, { status: 'ready', runtime: 'simulation' });
    if (path === '/simulation/ai/status' && request.method === 'GET')
      return json(200, {
        enabled: service.settings.enabled,
        provider: 'amazon-bedrock',
        modelId: service.settings.modelId,
        region: service.settings.region,
      });
    if (path === '/simulation/ai/plan') {
      try {
        if (request.method !== 'POST') throw new HttpError(405, 'Use POST.');
        const host = request.headers.host ?? '';
        const origin = request.headers.origin;
        const sameOrigin = publicUrl
          ? host === publicUrl.host && origin === publicUrl.origin
          : /^(localhost|127\.0\.0\.1):\d+$/.test(host) && origin === `http://${host}`;
        if (!sameOrigin || request.headers['x-simulation-request'] !== '1')
          throw new HttpError(
            403,
            'Simulation planning requires the configured same-origin request.',
          );
        if (request.headers['content-type']?.split(';')[0] !== 'application/json')
          throw new HttpError(415, 'Use application/json.');
        if (!service.settings.enabled)
          throw new HttpError(
            503,
            'Start npm run simulation:bedrock to enable the local Bedrock bridge.',
          );
        if (!rate.allow(request.socket.remoteAddress ?? '') || active >= 2)
          throw new HttpError(429, 'Planning capacity reached. Retry later.');
        let raw = '';
        for await (const part of request) {
          raw += part.toString();
          if (Buffer.byteLength(raw) > 65536)
            throw new HttpError(413, 'Planning request exceeds 64 KiB.');
        }
        let input: unknown;
        try {
          input = JSON.parse(raw);
        } catch {
          throw new HttpError(400, 'Invalid JSON.');
        }
        const { prompt, context } = z
          .object({ prompt: planRequestSchema.shape.prompt, context: contextSchema })
          .strict()
          .parse(input);
        if (context.source !== 'simulation')
          throw new HttpError(400, 'The preview bridge accepts simulation data only.');
        active++;
        try {
          return json(200, await service.plan(prompt, context));
        } finally {
          active--;
        }
      } catch (error) {
        return json(
          error instanceof HttpError ? error.status : error instanceof ZodError ? 400 : 503,
          {
            error:
              error instanceof HttpError
                ? error.message
                : 'Planning request could not be processed.',
          },
        );
      }
    }
    if (!['GET', 'HEAD'].includes(request.method ?? ''))
      return json(405, { error: 'Method not allowed.' });
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep) || !mime[extname(file)])
      return json(404, { error: 'Not found.' });
    try {
      const data = await readFile(file);
      response.writeHead(200, {
        'Content-Type': mime[extname(file)],
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch {
      json(404, { error: 'Not found.' });
    }
  });
}
