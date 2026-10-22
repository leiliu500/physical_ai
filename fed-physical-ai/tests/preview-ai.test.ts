import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createSimulationPreview } from '../src/simulation/preview-server.js';
import { BedrockAdvisor, bedrockSettings } from '../src/ai/bedrock.js';
test('local Bedrock bridge requires a same-origin loopback request and simulation context', async (t) => {
  let calls = 0;
  const server = createSimulationPreview(
    new BedrockAdvisor(bedrockSettings({ BEDROCK_ENABLED: 'true' }), {
      async send() {
        calls++;
        return {
          $metadata: {},
          stopReason: 'end_turn',
          output: {
            message: {
              role: 'assistant',
              content: [
                {
                  text: JSON.stringify({
                    summary: 'No sources connected.',
                    observations: [],
                    recommendations: [],
                    limitations: ['Enroll sources before dispatch.'],
                  }),
                },
              ],
            },
          },
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          metrics: { latencyMs: 1 },
        };
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const body = JSON.stringify({
    prompt: 'Summarize current operations.',
    context: {
      source: 'simulation',
      facilityId: 'SIM-PREVIEW',
      dispatchInhibited: true,
      devices: [],
      reviews: [],
    },
  });
  assert.equal(
    (
      await fetch(origin + '/simulation/ai/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
    ).status,
    403,
  );
  const headers = {
    'Content-Type': 'application/json',
    Origin: origin,
    'X-Simulation-Request': '1',
  };
  assert.equal(
    (
      await fetch(origin + '/simulation/ai/plan', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://other.invalid' },
        body,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(origin + '/simulation/ai/plan', {
        method: 'POST',
        headers,
        body: body.replace('"source":"simulation"', '"source":"production"'),
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(origin + '/simulation/ai/plan', { method: 'POST', headers, body })).status,
    200,
  );
  assert.equal(calls, 1);
});

test('hosted simulation binds planning to the configured ALB origin and exposes a harmless health check', async (t) => {
  let calls = 0;
  const publicOrigin = 'http://physical-ai.example.invalid';
  const server = createSimulationPreview(
    new BedrockAdvisor(bedrockSettings({ BEDROCK_ENABLED: 'true' }), {
      async send() {
        calls++;
        return {
          $metadata: {},
          stopReason: 'end_turn',
          output: {
            message: {
              role: 'assistant',
              content: [
                {
                  text: JSON.stringify({
                    summary: 'Synthetic facility has no sources.',
                    observations: [],
                    recommendations: [],
                    limitations: ['Synthetic context only.'],
                  }),
                },
              ],
            },
          },
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          metrics: { latencyMs: 1 },
        };
      },
    }),
    { publicOrigin },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await fetch(base + '/health/live')).status, 200);
  assert.equal(calls, 0);
  const headers = {
    Host: 'physical-ai.example.invalid',
    Origin: publicOrigin,
    'Content-Type': 'application/json',
    'X-Simulation-Request': '1',
  };
  const post = (payload: string, overrides: Record<string, string> = {}) =>
    new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(
        new URL('/simulation/ai/plan', base),
        { method: 'POST', headers: { ...headers, ...overrides } },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode!));
        },
      );
      outgoing.once('error', reject);
      outgoing.end(payload);
    });
  const body = JSON.stringify({
    prompt: 'Summarize this synthetic facility.',
    context: {
      source: 'simulation',
      facilityId: 'SIM-CLOUD',
      dispatchInhibited: true,
      devices: [],
      reviews: [],
    },
  });
  assert.equal(await post(body, { Origin: 'https://other.invalid' }), 403);
  assert.equal(await post(body, { Host: 'localhost:4174' }), 403);
  assert.equal(await post('null'), 400);
  assert.equal(await post(body), 200);
  assert.equal(calls, 1);
});

test('hosted simulation rejects a public URL containing credentials, paths or unsupported schemes', () => {
  for (const publicOrigin of [
    'file:///tmp/',
    'https://user:password@example.invalid',
    'https://example.invalid/path',
    'https://example.invalid/?token=example',
  ])
    assert.throws(() => createSimulationPreview(undefined, { publicOrigin }), /public origin/);
});
