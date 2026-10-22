import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, deviceConfiguration } from '../src/platform/config.js';
import { commandSchema } from '../src/platform/contracts.js';
import { configuration } from './support/fixtures.js';
import { createApp } from '../src/server.js';

test('service refuses missing database, OIDC and explicit safety policy', () => {
  assert.throws(() => loadConfig({}), /./);
  assert.throws(() => loadConfig({ APP_MODE: 'browser' }), /Unsupported/);
  assert.throws(() => loadConfig({ STORAGE_DRIVER: 'memory' }), /PostgreSQL/);
});
test('registries reject unsafe identifiers and incomplete execution settings', () => {
  assert.throws(
    () =>
      deviceConfiguration.parse(
        JSON.parse('{"__proto__":{"kind":"robot","secret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'),
      ),
    /./,
  );
  assert.throws(
    () =>
      deviceConfiguration.parse({
        robot: {
          kind: 'robot',
          secret: 'a'.repeat(40),
          commandEndpoint: 'https://gateway.invalid',
        },
      }),
    /together/,
  );
});
test('runtime cannot inject alternative persistence or execution adapters', () => {
  const config = configuration();
  config.environment = 'production';
  assert.throws(
    () =>
      createApp({
        config,
        gateway: {
          async send() {
            throw new Error();
          },
        },
      }),
    /production adapters/,
  );
});
test('legacy scenario commands are outside the production API contract', () => {
  for (const command of ['tick', 'reset', 'scenario', 'telemetry'])
    assert.equal(commandSchema.safeParse({ command, data: {} }).success, false);
});
