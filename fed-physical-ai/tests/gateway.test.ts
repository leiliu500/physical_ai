import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpsExecutionGateway, signature, validSignature } from '../src/platform/gateway.js';
import { configuration } from './support/fixtures.js';
import type { DeviceCommand } from '../src/core/types.js';

test('HTTPS gateway verifies signed acknowledgements and transmits stable command identity', async (t) => {
  const config = configuration(),
    gateway = new HttpsExecutionGateway(config);
  const command: DeviceCommand = {
    id: randomUUID(),
    deviceId: 'robot',
    action: 'transfer',
    parameters: { destination: 'secure-receiving' },
    status: 'dispatching',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    createdBy: 'operator',
    approvals: [],
  };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const reply = (status = 'accepted', override: Record<string, unknown> = {}, signed = true) => {
    const raw = JSON.stringify({
      commandId: command.id,
      deviceId: command.deviceId,
      status,
      timestamp: new Date().toISOString(),
      ...override,
    });
    return new Response(raw, {
      status: 200,
      headers: {
        'X-Device-Signature': signed ? signature(raw, config.devices.robot.secret) : 'invalid',
      },
    });
  };
  globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('Idempotency-Key'), command.id);
    assert.equal(init?.redirect, 'error');
    assert.equal(
      validSignature(
        String(init?.body),
        new Headers(init?.headers).get('X-Control-Signature')!,
        config.devices.robot.commandSecret!,
      ),
      true,
    );
    return reply();
  };
  assert.equal((await gateway.send(command)).status, 'accepted');
  await t.test('unsigned acknowledgements cannot confirm completion', async () => {
    globalThis.fetch = async () => reply('succeeded', {}, false);
    await assert.rejects(gateway.send(command), /signature/);
  });
  await t.test('acknowledgements must match the dispatched command and device', async () => {
    globalThis.fetch = async () => reply('succeeded', { commandId: randomUUID() });
    await assert.rejects(gateway.send(command), /match/);
  });
  await t.test('old acknowledgements cannot confirm a new command', async () => {
    globalThis.fetch = async () =>
      reply('succeeded', { timestamp: new Date(Date.now() - 120000).toISOString() });
    await assert.rejects(gateway.send(command), /stale/);
  });
});
