import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PostgresStore, verifyAudit } from '../src/platform/persistence.js';
import { Controller } from '../src/platform/controller.js';
import {
  configuration,
  acceptedGateway,
  observe,
  robotReading,
  release,
  transfer,
} from './support/fixtures.js';

test(
  'PostgreSQL restart, ownership, rollback and append-only audit',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = process.env.TEST_DATABASE_URL!,
      config = configuration();
    const tls = process.env.DATABASE_TLS !== 'false';
    const store = new PostgresStore(url, config.facilityId, tls),
      controller = new Controller(store, config, acceptedGateway());
    await controller.initialize();
    t.after(() => store.close());
    await t.test('only one controller may own the database', async () => {
      const duplicate = new PostgresStore(url, config.facilityId, tls);
      await assert.rejects(duplicate.initialize(), /Another controller/);
      await duplicate.close();
    });
    await t.test(
      'operator state and audit commit together; failed transactions roll back',
      async () => {
        await observe(controller, config, 'robot', robotReading());
        await release(controller);
        await transfer(controller);
        const before = await store.read();
        await assert.rejects(
          store.transact((document) => {
            document.operations.metrics.confirmedCommands = 999;
            throw new Error('rollback-test');
          }),
          /rollback-test/,
        );
        assert.deepEqual(await store.read(), before);
        const records = await store.audit(0, 1000);
        assert.equal(verifyAudit(records), true);
        assert.equal(before.auditHash, records.at(-1)?.hash);
      },
    );
    await store.close();
    const recovered = new PostgresStore(url, config.facilityId, tls),
      restarted = new Controller(recovered, config, acceptedGateway());
    await restarted.initialize();
    t.after(() => recovered.close());
    await t.test(
      'real database recovery retains observations and cancels old queued commands',
      async () => {
        const state = await restarted.state();
        assert.equal(state.devices.robot.sequence, 1);
        assert.equal(state.commands[0].status, 'cancelled');
        assert.equal(state.dispatchInhibited, true);
      },
    );
    await t.test('database blocks audit mutation and deletion', async () => {
      const pool = new Pool({
        connectionString: url,
        ssl: tls ? { rejectUnauthorized: true } : undefined,
      });
      try {
        await assert.rejects(
          pool.query("UPDATE platform_audit SET record='{}'::jsonb WHERE sequence=1"),
          /append.only/i,
        );
        await assert.rejects(
          pool.query('DELETE FROM platform_audit WHERE sequence=1'),
          /append.only/i,
        );
      } finally {
        await pool.end();
      }
    });
  },
);
