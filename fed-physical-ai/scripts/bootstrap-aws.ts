import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { z } from 'zod';
import { databaseSecretSchema } from '../src/platform/aws-secrets.js';

const input = z
  .object({
    AWS_REGION: z.string().min(1),
    DB_MASTER_SECRET_ARN: z.string().min(1),
    DATABASE_SECRET_ARN: z.string().min(1),
    DATABASE_HOST: z.string().regex(/^[a-zA-Z0-9.-]+$/),
    DATABASE_NAME: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  })
  .parse(process.env);
const secrets = new SecretsManagerClient({ region: input.AWS_REGION });
const read = async (id: string) => {
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: id }));
  if (!result.SecretString) throw new Error('Secret JSON is required.');
  return JSON.parse(result.SecretString) as unknown;
};
const master = z
  .object({ username: z.string().min(1), password: z.string().min(1) })
  .passthrough()
  .parse(await read(input.DB_MASTER_SECRET_ARN));
let appPassword: string;
try {
  const existing = databaseSecretSchema.parse(await read(input.DATABASE_SECRET_ARN));
  if (existing.host !== input.DATABASE_HOST || existing.dbname !== input.DATABASE_NAME)
    throw new Error('Existing runtime secret belongs to a different database.');
  appPassword = existing.password;
} catch (error) {
  if ((error as { name?: string }).name !== 'ResourceNotFoundException') throw error;
  appPassword = randomBytes(36).toString('base64url');
}
const url = new URL(`postgresql://${input.DATABASE_HOST}:5432/${input.DATABASE_NAME}`);
url.username = encodeURIComponent(master.username);
url.password = encodeURIComponent(master.password);
const migration = spawnSync(process.execPath, ['build/scripts/migrate.js'], {
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, DATABASE_URL: url.href, DATABASE_TLS: 'true' },
});
if (migration.status !== 0)
  throw new Error('Database migration failed. Runtime access was not provisioned.');
const pool = new Pool({
  connectionString: url.href,
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 5000,
});
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(7410323)');
  const role = await client.query(
    'SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1',
    ['physical_ai_app'],
  );
  if (role.rows[0] && Object.values(role.rows[0]).some(Boolean))
    throw new Error('Runtime role unexpectedly has administrative privileges.');
  const command = await client.query<{ statement: string }>(
    'SELECT format($1, $2, $3) AS statement',
    [
      role.rows.length
        ? 'ALTER ROLE %I WITH LOGIN PASSWORD %L'
        : 'CREATE ROLE %I WITH LOGIN PASSWORD %L',
      'physical_ai_app',
      appPassword,
    ],
  );
  await client.query(command.rows[0].statement);
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  const databaseGrant = await client.query<{ statement: string }>(
    "SELECT format('GRANT CONNECT ON DATABASE %I TO physical_ai_app', $1) AS statement",
    [input.DATABASE_NAME],
  );
  await client.query(databaseGrant.rows[0].statement);
  await client.query('GRANT USAGE ON SCHEMA public TO physical_ai_app');
  await client.query('GRANT SELECT, INSERT, UPDATE ON platform_state TO physical_ai_app');
  await client.query('GRANT SELECT, INSERT ON platform_audit TO physical_ai_app');
  await client.query('GRANT SELECT ON schema_migrations TO physical_ai_app');
  await client.query('COMMIT');
  await secrets.send(
    new PutSecretValueCommand({
      SecretId: input.DATABASE_SECRET_ARN,
      SecretString: JSON.stringify({
        username: 'physical_ai_app',
        password: appPassword,
        host: input.DATABASE_HOST,
        port: 5432,
        dbname: input.DATABASE_NAME,
      }),
    }),
  );
  console.log('Schema migrated and least-privilege runtime database identity provisioned.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
