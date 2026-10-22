import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDatabaseBootstrap, type BootstrapDriver } from '../src/deployment/ecs-bootstrap.js';

const config = {
  region: 'us-gov-west-1',
  cluster: 'arn:aws-us-gov:ecs:us-gov-west-1:123456789012:cluster/physical-ai-test',
  taskDefinition:
    'arn:aws-us-gov:ecs:us-gov-west-1:123456789012:task-definition/physical-ai-bootstrap:1',
  subnets: ['subnet-0123456789abcdef0', 'subnet-1123456789abcdef0'],
  securityGroup: 'sg-0123456789abcdef0',
};
const taskArn =
  'arn:aws-us-gov:ecs:us-gov-west-1:123456789012:task/physical-ai-test/0123456789abcdef0123456789abcdef';
function successfulDriver(events: string[] = []): BootstrapDriver {
  return {
    async run(input) {
      events.push('run');
      assert.equal(input.cluster, config.cluster);
      assert.equal(input.taskDefinition, config.taskDefinition);
      assert.equal(input.count, 1);
      assert.equal(input.launchType, 'FARGATE');
      assert.equal(input.networkConfiguration?.awsvpcConfiguration?.assignPublicIp, 'DISABLED');
      assert.deepEqual(input.networkConfiguration?.awsvpcConfiguration?.subnets, config.subnets);
      assert.deepEqual(input.networkConfiguration?.awsvpcConfiguration?.securityGroups, [
        config.securityGroup,
      ]);
      assert.ok(input.clientToken);
      return { $metadata: {}, tasks: [{ taskArn }] };
    },
    async wait(input) {
      events.push('wait');
      assert.deepEqual(input.tasks, [taskArn]);
    },
    async describe(input) {
      events.push('describe');
      assert.deepEqual(input.tasks, [taskArn]);
      return {
        $metadata: {},
        tasks: [
          { taskArn, lastStatus: 'STOPPED', containers: [{ name: 'controller', exitCode: 0 }] },
        ],
      };
    },
  };
}
test('Terraform bootstrap runs one private Fargate task and requires its confirmed successful exit', async () => {
  const events: string[] = [];
  assert.equal(await runDatabaseBootstrap(config, successfulDriver(events)), taskArn);
  assert.deepEqual(events, ['run', 'wait', 'describe']);
});
test('bootstrap rejects a commercial task ARN in a GovCloud deployment before invoking AWS', async () => {
  const events: string[] = [];
  await assert.rejects(
    runDatabaseBootstrap(
      { ...config, taskDefinition: config.taskDefinition.replace('aws-us-gov', 'aws') },
      successfulDriver(events),
    ),
    /partition/,
  );
  assert.deepEqual(events, []);
});
test('ECS start failures prevent bootstrap completion and do not wait for an absent task', async () => {
  const events: string[] = [];
  const driver = successfulDriver(events);
  driver.run = async () => ({ $metadata: {}, failures: [{ reason: 'Capacity unavailable.' }] });
  await assert.rejects(runDatabaseBootstrap(config, driver), /did not start exactly one/);
  assert.deepEqual(events, []);
});
test('a bootstrap wait failure prevents release and does not invent a successful exit', async () => {
  const events: string[] = [];
  const driver = successfulDriver(events);
  driver.wait = async () => {
    throw new Error('Task waiter timed out.');
  };
  await assert.rejects(runDatabaseBootstrap(config, driver), /timed out/);
  assert.deepEqual(events, ['run']);
});
test('a failed migration container prevents service release', async () => {
  const driver = successfulDriver();
  driver.describe = async () => ({
    $metadata: {},
    tasks: [{ taskArn, lastStatus: 'STOPPED', containers: [{ name: 'controller', exitCode: 1 }] }],
  });
  await assert.rejects(runDatabaseBootstrap(config, driver), /Bootstrap did not succeed/);
});
test('missing task evidence, running containers and absent exit codes cannot confirm bootstrap', async () => {
  for (const tasks of [
    [],
    [{ taskArn, lastStatus: 'RUNNING', containers: [{ name: 'controller', exitCode: 0 }] }],
    [{ taskArn, lastStatus: 'STOPPED', containers: [{ name: 'controller' }] }],
  ]) {
    const driver = successfulDriver();
    driver.describe = async () => ({ $metadata: {}, tasks });
    await assert.rejects(runDatabaseBootstrap(config, driver), /Bootstrap did not succeed/);
  }
});
