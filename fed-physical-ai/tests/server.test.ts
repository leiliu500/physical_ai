import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, EncryptJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { Authentication } from '../src/platform/auth.js';
import { signature } from '../src/platform/gateway.js';
import { configuration, TestStore, robotReading, acceptedGateway } from './support/fixtures.js';

test('HTTP service enforces actual signed identity, device ingress and mutation boundaries', async (t) => {
  const config = configuration(),
    store = new TestStore(),
    keys = await generateKeyPair('RS256');
  const auth = new Authentication(config, async () => keys.publicKey);
  const app = createApp({
    config,
    store,
    authentication: auth,
    gateway: acceptedGateway(),
    processOutbox: false,
  });
  await app.ready;
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await app.close();
  });
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const token = async (
    roles = ['supervisor'],
    facility = config.facilityId,
    audience = config.audience,
  ) =>
    new SignJWT({ roles, facility_id: facility, name: 'Test reviewer' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(config.issuer)
      .setSubject('reviewer')
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);
  const access = await token(),
    headers = { Authorization: `Bearer ${access}` };
  await t.test('anonymous and spoofed headers cannot read operational data', async () => {
    assert.equal((await fetch(origin + '/api/state')).status, 401);
    assert.equal(
      (await fetch(origin + '/api/state', { headers: { 'X-Operator': 'admin' } })).status,
      401,
    );
  });
  await t.test('JWT audience and facility claims are verified', async () => {
    for (const invalid of [
      await token(['viewer'], 'other-facility'),
      await token(['viewer'], config.facilityId, config.clientId),
    ])
      assert.ok(
        [401, 403].includes(
          (await fetch(origin + '/api/state', { headers: { Authorization: `Bearer ${invalid}` } }))
            .status,
        ),
      );
  });
  await t.test('device ingress requires a body signature and rejects replays', async () => {
    const body = JSON.stringify({
      deviceId: 'robot',
      sequence: 1,
      timestamp: new Date().toISOString(),
      reading: robotReading(),
    });
    const request = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-ID': 'robot',
        'X-Device-Signature': signature(body, config.devices.robot.secret),
      },
      body,
    };
    assert.equal(
      (
        await fetch(origin + '/api/device/telemetry', {
          ...request,
          headers: { ...request.headers, 'X-Device-Signature': 'invalid' },
        })
      ).status,
      401,
    );
    assert.equal((await fetch(origin + '/api/device/telemetry', request)).status, 202);
    assert.equal((await fetch(origin + '/api/device/telemetry', request)).status, 409);
  });
  await t.test('unauthenticated reading injection routes are absent', async () => {
    assert.equal(
      (
        await fetch(origin + '/api/telemetry', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      404,
    );
  });
  await t.test('commands require idempotency, roles and same-origin requests', async () => {
    const body = JSON.stringify({
      command: 'release-inhibit',
      data: { reason: 'Verified by operational reviewer.' },
    });
    assert.equal(
      (
        await fetch(origin + '/api/command', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(origin + '/api/command', {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            'Idempotency-Key': randomUUID(),
            Origin: 'https://other.invalid',
          },
          body,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + '/api/command', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await token(['viewer'])}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': randomUUID(),
          },
          body,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + '/api/command', {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            'Idempotency-Key': randomUUID(),
          },
          body,
        })
      ).status,
      200,
    );
  });
  await t.test('encrypted sessions require a matching origin and CSRF token', async () => {
    const session = await new EncryptJWT({
      roles: ['supervisor'],
      facility_id: config.facilityId,
      csrf: 'csrf-test',
    })
      .setSubject(config.issuer + '|reviewer')
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuer('reserve-platform')
      .setAudience(config.clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .encrypt(config.sessionKey);
    const sessionHeaders = {
        Cookie: '__Host-reserve_session=' + session,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body = JSON.stringify({ command: 'inhibit', data: { reason: 'Routine operational hold.' } });
    assert.equal(
      (await fetch(origin + '/api/command', { method: 'POST', headers: sessionHeaders, body }))
        .status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + '/api/command', {
          method: 'POST',
          headers: { ...sessionHeaders, Origin: config.origin, 'X-CSRF-Token': 'csrf-test' },
          body,
        })
      ).status,
      200,
    );
  });
  await t.test('readiness and audit expose durable control service state', async () => {
    assert.equal((await fetch(origin + '/health/ready')).status, 200);
    const response = await fetch(origin + '/api/audit', { headers });
    const value = (await response.json()) as { records: unknown[] };
    assert.ok(value.records.length >= 4);
    store.healthy = false;
    assert.equal((await fetch(origin + '/health/ready')).status, 503);
    assert.equal((await fetch(origin + '/api/state', { headers })).status, 503);
    store.healthy = true;
  });
  await t.test(
    'static console uses security headers and has no selectable runtime mode',
    async () => {
      const response = await fetch(origin + '/?mode=browser');
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Content-Security-Policy')!, /frame-ancestors 'none'/);
      assert.match(html, /operations.css/);
      assert.doesNotMatch(html, /operator-selector/);
    },
  );
});
