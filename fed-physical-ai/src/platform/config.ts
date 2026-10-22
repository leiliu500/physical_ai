import { z } from 'zod';
import { identifier } from './contracts.js';
import { bedrockSettings, type BedrockSettings } from '../ai/bedrock.js';
const https = z
  .string()
  .url()
  .refine((v) => new URL(v).protocol === 'https:', 'HTTPS is required.');
const registryKeys = z.unknown().superRefine((value, context) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (!identifier.safeParse(key).success)
        context.addIssue({ code: 'custom', path: [key], message: 'Invalid registry identifier.' });
    }
  }
});
export const deviceConfiguration = registryKeys.pipe(
  z.record(
    identifier,
    z
      .object({
        kind: z.enum(['robot', 'processing-line', 'environment', 'inspection']),
        secret: z.string().min(32).max(512),
        required: z.boolean().default(true),
        capabilities: z
          .array(z.enum(['transfer', 'hold', 'set-temperature', 'quarantine']))
          .default([]),
        commandEndpoint: https.optional(),
        commandSecret: z.string().min(32).max(512).optional(),
        destinations: z.array(z.string().min(1).max(100)).default([]),
      })
      .strict()
      .refine(
        (v) => Boolean(v.commandEndpoint) === Boolean(v.commandSecret),
        'An execution endpoint and its signing key must be configured together.',
      ),
  ),
);
export const policySchema = z
  .object({
    vibrationMax: z.number().positive(),
    lineTemperatureMax: z.number(),
    zoneTemperatureMax: z.number(),
    minimumInspectionConfidence: z.number().min(0).max(1),
    minimumRobotBattery: z.number().min(0).max(100),
    coolingSetpoint: z.number(),
    reviewTtlSeconds: z.number().int().min(30).max(3600),
    commandTtlSeconds: z.number().int().min(5).max(300),
  })
  .strict();
export const modelConfiguration = registryKeys.pipe(
  z.record(
    identifier,
    z
      .object({
        version: z.string().min(1),
        artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
        validationReference: z.string().min(1),
        approved: z.boolean(),
      })
      .strict(),
  ),
);
const env = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4173),
  PUBLIC_ORIGIN: https,
  FACILITY_ID: identifier,
  DATABASE_URL: z
    .string()
    .url()
    .refine((v) => ['postgres:', 'postgresql:'].includes(new URL(v).protocol)),
  DATABASE_TLS: z.enum(['true', 'false']).default('true'),
  OIDC_ISSUER: https,
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  SESSION_ENCRYPTION_KEY: z.string().min(1),
  DEVICE_KEYS_JSON: z.string().default('{}'),
  MODEL_REGISTRY_JSON: z.string().default('{}'),
  SAFETY_POLICY_JSON: z.string(),
  TELEMETRY_MAX_AGE_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(10000).default(6000),
  LOG_LEVEL: z.enum(['info', 'error', 'silent']).default('info'),
});
export interface PlatformConfig {
  environment: 'production' | 'development' | 'test';
  host: string;
  port: number;
  origin: string;
  facilityId: string;
  databaseUrl: string;
  databaseTls: boolean;
  issuer: string;
  audience: string;
  clientId: string;
  clientSecret: string;
  sessionKey: Uint8Array;
  devices: z.infer<typeof deviceConfiguration>;
  models: z.infer<typeof modelConfiguration>;
  policy: z.infer<typeof policySchema>;
  telemetryMaxAgeSeconds: number;
  rateLimit: number;
  logLevel: 'info' | 'error' | 'silent';
  bedrock: BedrockSettings;
}
export function loadConfig(values: NodeJS.ProcessEnv = process.env): PlatformConfig {
  if (
    values.APP_MODE !== undefined ||
    values.STATE_FILE !== undefined ||
    (values.AUTH_MODE !== undefined && values.AUTH_MODE !== 'oidc') ||
    (values.STORAGE_DRIVER !== undefined && values.STORAGE_DRIVER !== 'postgres')
  )
    throw new Error('Unsupported runtime mode. The service requires OIDC and PostgreSQL.');
  const e = env.parse(values),
    key = Buffer.from(e.SESSION_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) throw new Error('SESSION_ENCRYPTION_KEY must encode 32 random bytes.');
  if (new URL(e.PUBLIC_ORIGIN).origin !== e.PUBLIC_ORIGIN)
    throw new Error('PUBLIC_ORIGIN must not include a path or trailing slash.');
  if (e.OIDC_AUDIENCE === e.OIDC_CLIENT_ID)
    throw new Error('Resource API and web client audiences must be distinct.');
  if (e.NODE_ENV !== 'test' && Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('Use Node.js 24 LTS or a newer supported runtime.');
  const policy = policySchema.parse(JSON.parse(e.SAFETY_POLICY_JSON));
  if (policy.coolingSetpoint >= policy.zoneTemperatureMax)
    throw new Error('The approved cooling setpoint must be below the temperature alert threshold.');
  return {
    environment: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    origin: e.PUBLIC_ORIGIN,
    facilityId: e.FACILITY_ID,
    databaseUrl: e.DATABASE_URL,
    databaseTls: e.DATABASE_TLS === 'true',
    issuer: e.OIDC_ISSUER,
    audience: e.OIDC_AUDIENCE,
    clientId: e.OIDC_CLIENT_ID,
    clientSecret: e.OIDC_CLIENT_SECRET,
    sessionKey: key,
    devices: deviceConfiguration.parse(JSON.parse(e.DEVICE_KEYS_JSON)),
    models: modelConfiguration.parse(JSON.parse(e.MODEL_REGISTRY_JSON)),
    policy,
    telemetryMaxAgeSeconds: e.TELEMETRY_MAX_AGE_SECONDS,
    rateLimit: e.RATE_LIMIT_PER_MINUTE,
    logLevel: e.LOG_LEVEL,
    bedrock: bedrockSettings(values),
  };
}
