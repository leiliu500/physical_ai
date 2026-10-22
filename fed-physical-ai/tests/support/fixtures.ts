import { randomUUID } from 'node:crypto';
import { Controller } from '../../src/platform/controller.js';
import { loadConfig, type PlatformConfig } from '../../src/platform/config.js';
import { signature, type ExecutionGateway } from '../../src/platform/gateway.js';
import type { Observation, Reading, DeviceCommand } from '../../src/core/types.js';
import type { Principal } from '../../src/platform/contracts.js';
import {
  appendAudit,
  initialDocument,
  type Change,
  type PlatformDocument,
  type Store,
  type AuditRecord,
} from '../../src/platform/persistence.js';

// Test doubles are confined to test sources and are never copied to the runtime image.
export class TestStore implements Store {
  readonly driver = 'test';
  healthy = true;
  document = initialDocument('facility-test');
  records: AuditRecord[] = [];
  async initialize(): Promise<void> {
    this.healthy = true;
  }
  async transact<T>(operation: (document: PlatformDocument) => Change<T>): Promise<T> {
    const document = structuredClone(this.document),
      result = operation(document);
    if (result.changed !== false) {
      document.revision++;
      this.records.push(...appendAudit(document, result.audit ?? []));
      this.document = document;
    }
    return structuredClone(result.value);
  }
  async read(): Promise<PlatformDocument> {
    return structuredClone(this.document);
  }
  async audit(after: number, limit: number): Promise<AuditRecord[]> {
    return structuredClone(this.records.filter((r) => r.sequence > after).slice(0, limit));
  }
  async close(): Promise<void> {
    this.healthy = false;
  }
}
export function configuration(): PlatformConfig {
  const connection = {
    secret: 'test-observation-key-'.repeat(3),
    commandSecret: 'test-command-key-'.repeat(3),
    commandEndpoint: 'https://gateway.invalid/commands',
    destinations: [],
  };
  return loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'https://control.invalid',
    FACILITY_ID: 'facility-test',
    DATABASE_URL: 'postgresql://test@localhost/test',
    OIDC_ISSUER: 'https://identity.invalid',
    OIDC_AUDIENCE: 'physical-api',
    OIDC_CLIENT_ID: 'physical-web',
    OIDC_CLIENT_SECRET: 'test-client-secret',
    SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    LOG_LEVEL: 'silent',
    DEVICE_KEYS_JSON: JSON.stringify({
      robot: {
        ...connection,
        kind: 'robot',
        required: true,
        capabilities: ['transfer'],
        destinations: ['secure-receiving'],
      },
      line: { ...connection, kind: 'processing-line', required: false, capabilities: ['hold'] },
      zone: {
        ...connection,
        kind: 'environment',
        required: false,
        capabilities: ['set-temperature'],
      },
      inspection: {
        ...connection,
        kind: 'inspection',
        required: false,
        capabilities: ['quarantine'],
      },
    }),
    MODEL_REGISTRY_JSON: JSON.stringify({
      vision: {
        version: 'validated-1',
        artifactSha256: 'a'.repeat(64),
        validationReference: 'test-validation-reference',
        approved: true,
      },
    }),
    SAFETY_POLICY_JSON: JSON.stringify({
      vibrationMax: 4,
      lineTemperatureMax: 65,
      zoneTemperatureMax: 26,
      minimumInspectionConfidence: 0.98,
      minimumRobotBattery: 25,
      coolingSetpoint: 22,
      reviewTtlSeconds: 300,
      commandTtlSeconds: 30,
    }),
  });
}
export const principal = (
  subject = 'reviewer-a',
  roles: Principal['roles'] = ['supervisor'],
): Principal => ({ subject, roles, name: subject, authentication: 'bearer' });
export const robotReading = (
  overrides: Partial<Extract<Reading, { kind: 'robot' }>> = {},
): Reading => ({
  kind: 'robot',
  status: 'idle',
  battery: 80,
  position: { x: 2, y: 3, frame: 'facility-map' },
  safetyStop: false,
  interlockReady: true,
  ...overrides,
});
export const inspectionReading = (): Reading => ({
  kind: 'inspection',
  inspectionId: randomUUID(),
  bundleId: 'bundle-test',
  expectedCount: 100,
  observedCount: 99,
  confidence: 0.99,
  modelId: 'vision',
  modelVersion: 'validated-1',
  artifactSha256: 'a'.repeat(64),
});
export function acceptedGateway(commands: DeviceCommand[] = []): ExecutionGateway {
  return {
    async send(command) {
      commands.push(command);
      return {
        commandId: command.id,
        deviceId: command.deviceId,
        status: 'accepted',
        timestamp: new Date().toISOString(),
      };
    },
  };
}
export async function setup(gateway = acceptedGateway()) {
  const config = configuration(),
    store = new TestStore(),
    controller = new Controller(store, config, gateway);
  await controller.initialize();
  return { config, store, controller };
}
export async function observe(
  controller: Controller,
  config: PlatformConfig,
  deviceId: string,
  reading: Reading,
  sequence?: number,
): Promise<Observation> {
  const current = await controller.store.read();
  const observation: Observation = {
    deviceId,
    sequence: sequence ?? (current.deviceSequences[deviceId]?.sequence ?? 0) + 1,
    timestamp: new Date().toISOString(),
    reading,
  };
  const raw = Buffer.from(JSON.stringify(observation));
  await controller.ingest(
    controller.verifyDevice(raw, deviceId, signature(raw, config.devices[deviceId].secret)),
    randomUUID(),
  );
  return observation;
}
export async function execute(
  controller: Controller,
  command: string,
  data: Record<string, unknown>,
  actor = principal(),
  key = randomUUID(),
) {
  return controller.execute({ command, data }, actor, randomUUID(), key);
}
export async function release(controller: Controller) {
  return execute(controller, 'release-inhibit', {
    reason: 'Verified operational release conditions.',
  });
}
export async function transfer(controller: Controller) {
  return execute(
    controller,
    'transfer',
    { deviceId: 'robot', destination: 'secure-receiving', reference: 'transfer-test' },
    principal('operator', ['operator']),
  );
}
