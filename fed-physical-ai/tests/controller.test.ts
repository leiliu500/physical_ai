import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/platform/controller.js';
import { signature } from '../src/platform/gateway.js';
import { verifyAudit } from '../src/platform/persistence.js';
import {
  setup,
  observe,
  robotReading,
  inspectionReading,
  execute,
  release,
  transfer,
  principal,
  acceptedGateway,
} from './support/fixtures.js';

test('startup has no manufactured devices, readings, metrics or actions', async () => {
  const { controller } = await setup(),
    state = await controller.state();
  assert.deepEqual(state.devices, {});
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.proposals, []);
  assert.deepEqual(Object.values(state.metrics), [0, 0, 0, 0]);
  assert.equal(state.dispatchInhibited, true);
  await assert.rejects(release(controller), /Fresh/);
});
test('startup audits the effective policy and model registry without credentials', async () => {
  const { config, store } = await setup();
  assert.deepEqual(store.records[0].details.policy, config.policy);
  assert.deepEqual(store.records[0].details.models, config.models);
  assert.equal(JSON.stringify(store.records).includes(config.devices.robot.secret), false);
  assert.equal(JSON.stringify(store.records).includes(config.devices.robot.commandSecret!), false);
});
test('recovered evidence cannot authorize a reconfigured device or revoked model', async () => {
  const { config, controller } = await setup();
  await observe(controller, config, 'robot', robotReading());
  config.devices.robot.kind = 'environment';
  await assert.rejects(release(controller), /current device configuration/);
  config.devices.robot.kind = 'robot';
  await release(controller);
  await observe(controller, config, 'inspection', inspectionReading());
  const review = (await controller.state()).proposals[0];
  config.models.vision.approved = false;
  await assert.rejects(
    execute(controller, 'review', {
      id: review.id,
      action: 'approve',
      reviewToken: review.reviewToken,
    }),
    /provenance/,
  );
});
test('dispatch requires fresh observations, release, authorized destinations and operator role', async () => {
  const { controller, config } = await setup();
  await observe(controller, config, 'robot', robotReading());
  await assert.rejects(transfer(controller), /inhibited/);
  await release(controller);
  await assert.rejects(
    execute(controller, 'transfer', {
      deviceId: 'robot',
      destination: 'unauthorized',
      reference: 'test',
    }),
    /Destination/,
  );
  await assert.rejects(
    execute(controller, 'inhibit', { reason: 'test reason' }, principal('viewer', ['viewer'])),
    /role/,
  );
  const state = await transfer(controller);
  assert.equal(state.commands[0].status, 'queued');
  assert.equal(state.metrics.completedTransfers, 0);
});
test('missing execution adapter prevents command creation', async () => {
  const { controller, config } = await setup();
  delete config.devices.robot.commandEndpoint;
  delete config.devices.robot.commandSecret;
  await observe(controller, config, 'robot', robotReading());
  await release(controller);
  await assert.rejects(transfer(controller), /execution capability/);
});
test('hardware interlock, safety stop, fault and low battery prevent release', async () => {
  for (const reading of [
    robotReading({ interlockReady: false }),
    robotReading({ safetyStop: true }),
    robotReading({ status: 'fault' }),
    robotReading({ battery: 10 }),
  ]) {
    const { controller, config } = await setup();
    await observe(controller, config, 'robot', reading);
    await assert.rejects(release(controller), /interlocks/);
  }
});
test('idempotency is actor scoped, durable and rejects payload conflicts', async () => {
  const { controller, config, store } = await setup();
  await observe(controller, config, 'robot', robotReading());
  await release(controller);
  const key = randomUUID(),
    data = { deviceId: 'robot', destination: 'secure-receiving', reference: 'test' };
  await execute(controller, 'transfer', data, principal(), key);
  await execute(controller, 'transfer', data, principal(), key);
  assert.equal((await controller.state()).commands.length, 1);
  await assert.rejects(
    execute(controller, 'transfer', { ...data, reference: 'changed' }, principal(), key),
    /conflicts/,
  );
  assert.equal(verifyAudit(store.records), true);
});
test('gateway acceptance does not count a completed physical action', async () => {
  const { controller, config } = await setup();
  await observe(controller, config, 'robot', robotReading());
  await release(controller);
  await transfer(controller);
  await controller.processOutbox();
  const state = await controller.state();
  assert.equal(state.commands[0].status, 'accepted');
  assert.equal(state.metrics.completedTransfers, 0);
  assert.equal(state.metrics.confirmedCommands, 0);
  const raw = Buffer.from(
    JSON.stringify({
      deviceId: 'robot',
      sequence: 2,
      timestamp: new Date().toISOString(),
      acknowledgement: {
        commandId: state.commands[0].id,
        deviceId: 'robot',
        status: 'succeeded',
        timestamp: new Date().toISOString(),
      },
    }),
  );
  const envelope = controller.verifyDevice(
    raw,
    'robot',
    signature(raw, config.devices.robot.secret),
    true,
  );
  await controller.ingest(envelope, randomUUID());
  await assert.rejects(controller.ingest(envelope, randomUUID()), /replayed/);
  assert.equal((await controller.state()).metrics.completedTransfers, 1);
});
test('an unknown transmission outcome inhibits dispatch and is never automatically retried', async () => {
  let attempts = 0;
  const { controller, config } = await setup({
    async send() {
      attempts++;
      throw new Error('timeout');
    },
  });
  await observe(controller, config, 'robot', robotReading());
  await release(controller);
  await transfer(controller);
  await controller.processOutbox();
  await controller.processOutbox();
  const state = await controller.state();
  assert.equal(attempts, 1);
  assert.equal(state.commands[0].status, 'uncertain');
  assert.equal(state.dispatchInhibited, true);
  await assert.rejects(release(controller), /reconciled/);
});
test('a missing completion acknowledgement becomes uncertain after its deadline', async () => {
  const { controller, config, store } = await setup();
  await observe(controller, config, 'robot', robotReading());
  await release(controller);
  await transfer(controller);
  await controller.processOutbox();
  store.document.operations.commands[0].expiresAt = new Date(Date.now() - 1).toISOString();
  await controller.processOutbox();
  assert.equal((await controller.state()).commands[0].status, 'uncertain');
  assert.equal((await controller.state()).dispatchInhibited, true);
});
test('stale device observations latch inhibition before any network transmission', async () => {
  const calls: Parameters<ReturnType<typeof acceptedGateway>['send']>[0][] = [];
  const { controller, config, store } = await setup(acceptedGateway(calls));
  await observe(controller, config, 'robot', robotReading());
  await release(controller);
  await transfer(controller);
  store.document.operations.devices.robot.observedAt = new Date(Date.now() - 120000).toISOString();
  await controller.processOutbox();
  assert.equal(calls.length, 0);
  assert.equal((await controller.state()).dispatchInhibited, true);
  assert.equal((await controller.state()).commands[0].status, 'cancelled');
});
test('inspection quarantine requires two distinct identities and current evidence', async () => {
  const { controller, config } = await setup();
  await observe(controller, config, 'robot', robotReading());
  await observe(controller, config, 'inspection', inspectionReading());
  await release(controller);
  const review = (await controller.state()).proposals[0],
    data = { id: review.id, action: 'approve', reviewToken: review.reviewToken };
  await execute(controller, 'review', data, principal('reviewer-a'));
  await assert.rejects(execute(controller, 'review', data, principal('reviewer-a')), /distinct/);
  assert.equal((await controller.state()).commands.length, 0);
  const state = await execute(controller, 'review', data, principal('reviewer-b'));
  assert.equal(state.commands[0].status, 'queued');
  assert.deepEqual(state.commands[0].approvals, ['reviewer-a', 'reviewer-b']);
  assert.equal(state.metrics.confirmedCommands, 0);
});
test('new model evidence clears prior approvals and invalidates stale review tokens', async () => {
  const { controller, config } = await setup();
  await observe(controller, config, 'robot', robotReading());
  await observe(controller, config, 'inspection', inspectionReading());
  await release(controller);
  const review = (await controller.state()).proposals[0];
  await execute(controller, 'review', {
    id: review.id,
    action: 'approve',
    reviewToken: review.reviewToken,
  });
  await observe(controller, config, 'inspection', inspectionReading());
  const updated = (await controller.state()).proposals[0];
  assert.deepEqual(updated.approvals, []);
  assert.equal(updated.revision, 2);
  await assert.rejects(
    execute(controller, 'review', {
      id: review.id,
      action: 'approve',
      reviewToken: review.reviewToken,
    }),
    /evidence changed/,
  );
});
test('changed equipment evidence cancels an approved command before transmission', async () => {
  const { controller, config } = await setup();
  await observe(controller, config, 'robot', robotReading());
  await observe(controller, config, 'line', {
    kind: 'processing-line',
    vibration: 7,
    temperature: 50,
    runState: 'running',
  });
  await release(controller);
  const p = (await controller.state()).proposals[0];
  await execute(controller, 'review', { id: p.id, action: 'approve', reviewToken: p.reviewToken });
  await observe(controller, config, 'line', {
    kind: 'processing-line',
    vibration: 8,
    temperature: 50,
    runState: 'running',
  });
  await controller.processOutbox();
  assert.equal((await controller.state()).commands[0].status, 'cancelled');
});
test('wrong signatures, stale messages and unapproved model artifacts are rejected', async () => {
  const { controller, config } = await setup();
  const reading = inspectionReading();
  if (reading.kind !== 'inspection') throw new Error();
  const make = (r = reading, timestamp = new Date().toISOString()) =>
    Buffer.from(JSON.stringify({ deviceId: 'inspection', sequence: 1, timestamp, reading: r }));
  const raw = make();
  assert.throws(
    () => controller.verifyDevice(raw, 'inspection', 'sha256=' + '0'.repeat(64)),
    /signature/,
  );
  const stale = make(reading, new Date(Date.now() - 120000).toISOString());
  assert.throws(
    () =>
      controller.verifyDevice(
        stale,
        'inspection',
        signature(stale, config.devices.inspection.secret),
      ),
    /stale/,
  );
  const wrong = make({ ...reading, artifactSha256: 'b'.repeat(64) });
  assert.throws(
    () =>
      controller.verifyDevice(
        wrong,
        'inspection',
        signature(wrong, config.devices.inspection.secret),
      ),
    /provenance/,
  );
});
test('restart preserves replay protection and invalidates old dispatch authorizations', async () => {
  const { controller, config, store } = await setup();
  const observation = await observe(controller, config, 'robot', robotReading());
  await release(controller);
  await transfer(controller);
  const restarted = new Controller(store, config, acceptedGateway());
  await restarted.initialize();
  const state = await restarted.state();
  assert.equal(state.dispatchInhibited, true);
  assert.equal(state.commands[0].status, 'cancelled');
  const raw = Buffer.from(JSON.stringify(observation));
  await assert.rejects(
    restarted.ingest(
      restarted.verifyDevice(raw, 'robot', signature(raw, config.devices.robot.secret)),
      randomUUID(),
    ),
    /replayed/,
  );
});
