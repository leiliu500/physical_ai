import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { BedrockAdvisor, bedrockSettings, type ConverseTransport } from '../src/ai/bedrock.js';
import { BEDROCK_MODEL_ID, type AdvisorContext, type Advice } from '../src/ai/contracts.js';
import { advisorContext } from '../src/ai/context.js';
import { PlanningService } from '../src/ai/service.js';
import { setup, observe, robotReading, principal } from './support/fixtures.js';
import { loadAwsSecrets } from '../src/platform/aws-secrets.js';
const settings = bedrockSettings({ BEDROCK_ENABLED: 'true' });
const context: AdvisorContext = {
  source: 'simulation',
  facilityId: 'SIM-TEST',
  dispatchInhibited: false,
  devices: [
    {
      id: 'SIM-AMR-01',
      kind: 'robot',
      observedAt: new Date().toISOString(),
      reading: robotReading(),
      destinations: ['Receiving'],
      capabilities: ['transfer'],
    },
  ],
  reviews: [],
};
const advice: Advice = {
  summary: 'A transfer can be prepared for operator review.',
  observations: ['A registered robot is reporting idle.'],
  recommendations: [
    {
      kind: 'transfer',
      deviceId: 'SIM-AMR-01',
      destination: 'Receiving',
      rationale: 'Use the configured receiving destination.',
    },
  ],
  limitations: ['The controller must recheck the current evidence before dispatch.'],
};
const reply = (
  value: unknown,
  stopReason: ConverseCommandOutput['stopReason'] = 'end_turn',
): ConverseCommandOutput => ({
  $metadata: {},
  stopReason,
  output: { message: { role: 'assistant', content: [{ text: JSON.stringify(value) }] } },
  usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
  metrics: { latencyMs: 10 },
});
test('Bedrock request uses the exact requested model with bounded inference and structured output', async () => {
  const transport: ConverseTransport = {
    async send(command, options) {
      assert.equal(command.input.modelId, BEDROCK_MODEL_ID);
      assert.deepEqual(command.input.additionalModelRequestFields, { reasoning_effort: 'low' });
      assert.equal(command.input.inferenceConfig?.maxTokens, 2048);
      assert.ok(options?.abortSignal);
      assert.equal(command.input.toolConfig, undefined);
      return reply(advice);
    },
  };
  const result = await new BedrockAdvisor(settings, transport).plan(
    'Prepare a receiving transfer.',
    context,
  );
  assert.equal(result.modelId, BEDROCK_MODEL_ID);
  assert.equal(result.source, 'simulation');
  assert.equal(result.contextDigest.length, 64);
  assert.equal(result.usage.outputTokens, 100);
});
test('Bedrock credentials and service errors never produce fabricated advice', async () => {
  await assert.rejects(
    new BedrockAdvisor(settings, {
      async send() {
        throw new Error('InvalidClientTokenId');
      },
    }).plan('Summarize current operations.', context),
    /AWS session validity/,
  );
});
test('Bedrock rejects invented devices, destinations and pending reviews', async () => {
  for (const recommendation of [
    {
      kind: 'transfer',
      deviceId: 'UNREGISTERED',
      destination: 'Receiving',
      rationale: 'Test invalid device.',
    },
    {
      kind: 'transfer',
      deviceId: 'SIM-AMR-01',
      destination: 'Unknown',
      rationale: 'Test invalid destination.',
    },
    { kind: 'review', proposalId: randomUUID(), rationale: 'Test invalid review.' },
  ])
    await assert.rejects(
      new BedrockAdvisor(settings, {
        async send() {
          return reply({ ...advice, recommendations: [recommendation] });
        },
      }).plan('Summarize current operations.', context),
      /Bedrock proposed/,
    );
});
test('Bedrock rejects malformed, executable and incomplete model outputs', async () => {
  for (const value of [
    { summary: 'not the required schema' },
    {
      ...advice,
      recommendations: [{ kind: 'release-inhibit', rationale: 'Bypass the interlock.' }],
    },
  ])
    await assert.rejects(
      new BedrockAdvisor(settings, {
        async send() {
          return reply(value);
        },
      }).plan('Summarize current operations.', context),
      /invalid recommendation schema/,
    );
  await assert.rejects(
    new BedrockAdvisor(settings, {
      async send() {
        return reply(advice, 'max_tokens');
      },
    }).plan('Summarize current operations.', context),
    /complete final answer/,
  );
});
test('Bedrock remains disabled by default and refuses alternative model identifiers', async () => {
  assert.equal(bedrockSettings({}).enabled, false);
  assert.equal(bedrockSettings({}).region, 'us-gov-west-1');
  assert.equal(bedrockSettings({ AWS_REGION: 'us-west-2' }).region, 'us-west-2');
  assert.equal(
    bedrockSettings({ AWS_REGION: 'us-west-2', BEDROCK_REGION: 'us-gov-west-1' }).region,
    'us-gov-west-1',
  );
  assert.throws(() => bedrockSettings({ BEDROCK_MODEL_ID: 'other-model' }));
  await assert.rejects(
    new BedrockAdvisor(bedrockSettings({}), {
      async send() {
        throw new Error('Must not call.');
      },
    }).plan('Summarize current operations.', context),
    /not enabled/,
  );
});
test('planning records audited recommendations without queuing physical commands', async () => {
  const { config, controller, store } = await setup();
  await observe(controller, config, 'robot', robotReading());
  const validAdvice = {
    ...advice,
    recommendations: [
      {
        kind: 'transfer',
        deviceId: 'robot',
        destination: 'secure-receiving',
        rationale: 'Prepare an authorized transfer.',
      },
    ],
  };
  const service = new PlanningService(
    controller,
    new BedrockAdvisor(settings, {
      async send() {
        return reply(validAdvice);
      },
    }),
  );
  await assert.rejects(
    service.plan({ prompt: 'Plan the next transfer.' }, principal('viewer', ['viewer'])),
    /role/,
  );
  const result = await service.plan({ prompt: 'Plan the next transfer.' }, principal());
  assert.equal(result.recommendations.length, 1);
  assert.equal((await controller.state()).commands.length, 0);
  assert.ok(store.records.some((record) => record.action === 'ai.recommended'));
  const snapshot = JSON.stringify(advisorContext(await controller.state(), config, 'production'));
  assert.equal(snapshot.includes(config.devices.robot.secret), false);
  assert.equal(snapshot.includes(config.devices.robot.commandSecret!), false);
  assert.equal(snapshot.includes('clientSecret'), false);
});
test('planning requires durable audit before model invocation', async () => {
  const { controller, store } = await setup();
  let calls = 0;
  const service = new PlanningService(
    controller,
    new BedrockAdvisor(settings, {
      async send() {
        calls++;
        return reply(advice);
      },
    }),
  );
  store.transact = async () => {
    throw new Error('Database unavailable.');
  };
  await assert.rejects(
    service.plan({ prompt: 'Summarize current operations.' }, principal()),
    /Database unavailable/,
  );
  assert.equal(calls, 0);
});
test('AWS runtime secrets are resolved without embedding database passwords in Terraform', async () => {
  const password = 'a-b_c%password'.repeat(3),
    values = { APP_SECRET_ARN: 'app', DATABASE_SECRET_ARN: 'db', AWS_REGION: 'us-east-1' };
  const env = await loadAwsSecrets(values, {
    async send(command) {
      return {
        SecretString: JSON.stringify(
          command.input.SecretId === 'app'
            ? {
                OIDC_CLIENT_SECRET: 'secret',
                SESSION_ENCRYPTION_KEY: 'session',
                DEVICE_KEYS_JSON: '{}',
                MODEL_REGISTRY_JSON: '{}',
                SAFETY_POLICY_JSON: '{}',
              }
            : {
                username: 'physical_ai_app',
                password,
                host: 'database.example.org',
                port: 5432,
                dbname: 'physical_ai',
              },
        ),
      };
    },
  });
  assert.equal(decodeURIComponent(new URL(env.DATABASE_URL!).password), password);
  assert.equal(env.DATABASE_TLS, 'true');
  assert.equal(env.OIDC_CLIENT_SECRET, 'secret');
  assert.equal('DATABASE_URL' in values, false);
});
test('application secrets cannot inject AWS credentials or arbitrary runtime settings', async () => {
  await assert.rejects(
    loadAwsSecrets(
      { APP_SECRET_ARN: 'app' },
      {
        async send() {
          return {
            SecretString: JSON.stringify({
              OIDC_CLIENT_SECRET: 'secret',
              SESSION_ENCRYPTION_KEY: 'session',
              DEVICE_KEYS_JSON: '{}',
              MODEL_REGISTRY_JSON: '{}',
              SAFETY_POLICY_JSON: '{}',
              AWS_SECRET_ACCESS_KEY: 'unwanted',
            }),
          };
        },
      },
    ),
  );
});
