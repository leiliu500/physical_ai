import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_TLS === 'false' ? undefined : { rejectUnauthorized: true },
  connectionTimeoutMillis: 5000,
});
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(7410322)');
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const root = new URL('../../migrations/', import.meta.url),
    files = (await readdir(root)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  for (const file of files) {
    const version = Number(file.split('_')[0]),
      sql = (await readFile(new URL(file, root), 'utf8')).replace(/\r\n/g, '\n'),
      checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE version=$1',
      [version],
    );
    if (existing.rows.length) {
      if (existing.rows[0].checksum !== checksum)
        throw new Error('Applied migration checksum mismatch: ' + file);
    } else {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [
        version,
        checksum,
      ]);
    }
  }
  await client.query('COMMIT');
  console.log('Production database schema version 2 is ready.');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
  await pool.end();
}
