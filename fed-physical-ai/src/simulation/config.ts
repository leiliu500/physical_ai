import type { PlatformConfig } from '../platform/config.js';
import { digest } from '../platform/document.js';
export const locations: Record<string, { x: number; y: number }> = {
  'Receiving dock': { x: 90, y: 140 },
  'Cash processing': { x: 340, y: 140 },
  'Secure storage': { x: 590, y: 140 },
};
export const robotIds = ['SIM-AMR-01', 'SIM-AMR-02', 'SIM-AMR-03'];
export function simulationConfig(): PlatformConfig {
  const devices: PlatformConfig['devices'] = {};
  for (const id of robotIds)
    devices[id] = {
      kind: 'robot',
      required: true,
      secret: `simulation-observation-key-only-${id}`,
      commandSecret: `simulation-command-key-only-${id}`,
      commandEndpoint: `https://simulation.invalid/${id}`,
      capabilities: ['transfer'],
      destinations: Object.keys(locations),
    };
  for (const [id, kind, capability] of [
    ['SIM-LINE-01', 'processing-line', 'hold'],
    ['SIM-HVAC-01', 'environment', 'set-temperature'],
    ['SIM-VISION-01', 'inspection', 'quarantine'],
  ] as const)
    devices[id] = {
      kind,
      required: kind !== 'inspection',
      secret: `simulation-observation-key-only-${id}`,
      commandSecret: `simulation-command-key-only-${id}`,
      commandEndpoint: `https://simulation.invalid/${id}`,
      capabilities: [capability],
      destinations: [],
    };
  return {
    environment: 'development',
    host: '127.0.0.1',
    port: 4173,
    origin: 'https://simulation.invalid',
    facilityId: 'SIM-RESERVE-OPERATIONS',
    databaseUrl: 'postgresql://unused.invalid/simulation',
    databaseTls: true,
    issuer: 'https://simulation.invalid',
    audience: 'simulation-only',
    clientId: 'simulation-only-web',
    clientSecret: 'unused',
    sessionKey: new Uint8Array(32),
    devices,
    models: {
      'SIM-vision': {
        version: 'synthetic-1',
        artifactSha256: digest('synthetic-inspection-model-not-an-inference-artifact'),
        validationReference: 'Simulation fixture; no qualified model or physical inference',
        approved: true,
      },
    },
    policy: {
      vibrationMax: 4.5,
      lineTemperatureMax: 65,
      zoneTemperatureMax: 27,
      minimumInspectionConfidence: 0.98,
      minimumRobotBattery: 20,
      coolingSetpoint: 22,
      reviewTtlSeconds: 3600,
      commandTtlSeconds: 300,
    },
    telemetryMaxAgeSeconds: 120,
    rateLimit: 6000,
    logLevel: 'silent',
    bedrock: {
      enabled: false,
      region: 'us-gov-west-1',
      modelId: 'openai.gpt-oss-120b-1:0',
      maxTokens: 2048,
      timeoutMs: 45000,
    },
  };
}
