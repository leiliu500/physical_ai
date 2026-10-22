import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
export const databaseSecretSchema = z
  .object({
    username: z.literal('physical_ai_app'),
    password: z.string().min(24).max(256),
    host: z.string().regex(/^[a-zA-Z0-9.-]+$/),
    port: z.number().int().min(1).max(65535).default(5432),
    dbname: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  })
  .strict();
const appSecretSchema = z
  .object({
    OIDC_CLIENT_SECRET: z.string().min(1),
    SESSION_ENCRYPTION_KEY: z.string().min(1),
    DEVICE_KEYS_JSON: z.string(),
    MODEL_REGISTRY_JSON: z.string(),
    SAFETY_POLICY_JSON: z.string(),
  })
  .strict();
export interface SecretReader {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}
export async function loadAwsSecrets(
  values: NodeJS.ProcessEnv = process.env,
  reader?: SecretReader,
): Promise<NodeJS.ProcessEnv> {
  const env = { ...values };
  if (!env.APP_SECRET_ARN && !env.DATABASE_SECRET_ARN) return env;
  const client = reader ?? new SecretsManagerClient({ region: env.AWS_REGION, maxAttempts: 2 });
  const secret = async (id: string): Promise<unknown> => {
    const result = await client.send(new GetSecretValueCommand({ SecretId: id }));
    if (!result.SecretString) throw new Error('Secret has no JSON string.');
    return JSON.parse(result.SecretString);
  };
  if (env.APP_SECRET_ARN)
    Object.assign(env, appSecretSchema.parse(await secret(env.APP_SECRET_ARN)));
  if (env.DATABASE_SECRET_ARN) {
    const db = databaseSecretSchema.parse(await secret(env.DATABASE_SECRET_ARN));
    const url = new URL(`postgresql://${db.host}:${db.port}/${db.dbname}`);
    url.username = encodeURIComponent(db.username);
    url.password = encodeURIComponent(db.password);
    env.DATABASE_URL = url.href;
    env.DATABASE_TLS = 'true';
  }
  return env;
}
