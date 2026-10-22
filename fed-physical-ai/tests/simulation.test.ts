import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash as nodeHash, createHmac as nodeHmac } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { SimulationRuntime, type SimulationStatus } from '../src/simulation/runtime.js';
import { createHash, createHmac } from '../src/simulation/browser-crypto.js';
import type { OperationsState } from '../src/core/types.js';
import { verifyAudit, type AuditRecord } from '../src/platform/document.js';

const state = async (runtime: SimulationRuntime) =>
  (await runtime.request('/api/state')) as OperationsState;
const status = async (runtime: SimulationRuntime) =>
  ((await runtime.request('/api/platform')) as { simulation: SimulationStatus }).simulation;
test('simulation browser hashes match the production SHA-256 and HMAC implementation', () => {
  const value = 'Synthetic device observation: \u2713',
    secret = 'simulation-only-key';
  assert.equal(
    createHash('sha256').update(value).digest('hex'),
    nodeHash('sha256').update(value).digest('hex'),
  );
  assert.equal(
    createHmac('sha256', secret).update(value).digest('hex'),
    nodeHmac('sha256', secret).update(value).digest('hex'),
  );
});
test('simulation starts active with synthetic sources and pending acknowledged transfers', async () => {
  const runtime = new SimulationRuntime(),
    current = await state(runtime);
  assert.equal(Object.keys(current.devices).length, 6);
  assert.equal(current.dispatchInhibited, false);
  assert.equal(current.commands.filter((c) => c.status === 'accepted').length, 3);
  assert.equal(current.metrics.completedTransfers, 0);
  assert.equal(current.proposals[0].action, 'quarantine');
  const position = current.devices['SIM-AMR-01'].reading;
  await runtime.tick();
  const moved = (await state(runtime)).devices['SIM-AMR-01'].reading;
  assert.notDeepEqual(position, moved);
  for (let i = 0; i < 8; i++) await runtime.tick();
  assert.equal((await state(runtime)).metrics.completedTransfers, 3);
  const audit = (await runtime.request('/api/audit?limit=1000')) as { records: AuditRecord[] };
  assert.equal(verifyAudit(audit.records), true);
});
test('simulation pause, single step and reset preserve explicit session semantics', async () => {
  const runtime = new SimulationRuntime();
  await runtime.request('/simulation/control', { action: 'pause' });
  await runtime.tick();
  assert.equal((await status(runtime)).elapsedSeconds, 0);
  await runtime.request('/simulation/control', { action: 'step' });
  assert.equal((await status(runtime)).elapsedSeconds, 1);
  assert.equal((await status(runtime)).running, false);
  await runtime.request('/simulation/control', { action: 'reset' });
  assert.equal((await status(runtime)).elapsedSeconds, 0);
  assert.equal((await status(runtime)).running, true);
  assert.equal((await state(runtime)).metrics.completedTransfers, 0);
});
test('simulation quarantine exercises the same distinct-reviewer quorum as production', async () => {
  const runtime = new SimulationRuntime(),
    proposal = (await state(runtime)).proposals[0];
  const input = {
    command: 'review',
    data: { id: proposal.id, action: 'approve', reviewToken: proposal.reviewToken },
  };
  await runtime.request('/api/command', input);
  await assert.rejects(runtime.request('/api/command', input), /distinct/);
  await runtime.request('/simulation/control', { action: 'reviewer', reviewer: 'b' });
  await runtime.request('/api/command', input);
  assert.equal(
    (await state(runtime)).commands.find((c) => c.proposalId === proposal.id)?.status,
    'queued',
  );
  for (let i = 0; i < 4; i++) await runtime.tick();
  assert.equal(
    (await state(runtime)).commands.find((c) => c.proposalId === proposal.id)?.status,
    'succeeded',
  );
});
test('simulation interlock stops the affected robot and requires an explicit release after recovery', async () => {
  const runtime = new SimulationRuntime();
  await runtime.request('/simulation/control', { action: 'scenario', scenario: 'interlock' });
  const before = (await state(runtime)).devices['SIM-AMR-01'].reading;
  for (let i = 0; i < 3; i++) await runtime.tick();
  const after = (await state(runtime)).devices['SIM-AMR-01'].reading;
  if (before.kind !== 'robot' || after.kind !== 'robot') throw new Error('Unexpected device kind.');
  assert.deepEqual(before.position, after.position);
  assert.equal((await state(runtime)).dispatchInhibited, true);
  await runtime.request('/simulation/control', { action: 'scenario', scenario: 'normal' });
  assert.equal((await state(runtime)).dispatchInhibited, true);
  await runtime.request('/api/command', {
    command: 'release-inhibit',
    data: { reason: 'Recovered synthetic interlock verified.' },
  });
  assert.equal((await state(runtime)).dispatchInhibited, false);
});
test('production static output excludes the simulation runtime and cannot select it by URL', async () => {
  const index = await readFile(new URL('../../dist/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(index, /data-runtime="simulation"/);
  await assert.rejects(access(new URL('../../dist/simulation/browser.js', import.meta.url)));
});
