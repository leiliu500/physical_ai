import { Pool, type PoolClient } from 'pg';
import {
  appendAudit,
  initialDocument,
  verifyAudit,
  type PlatformDocument,
  type AuditRecord,
  type Store,
  type Change,
} from './document.js';
export * from './document.js';
function validate(document: PlatformDocument, facilityId: string): void {
  if (
    document?.schemaVersion !== 2 ||
    document.operations?.version !== 2 ||
    document.operations.facilityId !== facilityId ||
    !Number.isSafeInteger(document.revision) ||
    document.revision < 0 ||
    !Number.isSafeInteger(document.auditSequence) ||
    document.auditSequence < 0 ||
    !/^[a-f0-9]{64}$/.test(document.auditHash) ||
    !Array.isArray(document.operations.commands) ||
    !Array.isArray(document.operations.proposals) ||
    typeof document.operations.dispatchInhibited !== 'boolean' ||
    !document.deviceSequences ||
    !document.receipts
  )
    throw new Error(
      'Unsupported facility checkpoint. Provision a production schema v2 database and preserve the previous audit separately.',
    );
}
export class PostgresStore implements Store {
  readonly driver = 'postgres';
  healthy = false;
  private pool: Pool;
  private lease?: PoolClient;
  private closed = false;
  constructor(
    url: string,
    private facilityId: string,
    tls = true,
  ) {
    this.pool = new Pool({
      connectionString: url,
      ssl: tls ? { rejectUnauthorized: true } : undefined,
      max: 8,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 5000,
    });
    this.pool.on('error', () => {
      this.healthy = false;
    });
  }
  async initialize(): Promise<void> {
    this.lease = await this.pool.connect();
    this.lease.on('error', () => {
      this.healthy = false;
    });
    try {
      if (
        !(
          await this.lease.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock(7410321) AS locked',
          )
        ).rows[0].locked
      )
        throw new Error('Another controller owns this facility database.');
      const schema = await this.pool.query(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      );
      if (schema.rows[0]?.version !== 2)
        throw new Error('Apply database migrations through version 2 before starting the service.');
      await this.pool.query(
        'INSERT INTO platform_state(id,document) VALUES(1,$1) ON CONFLICT(id) DO NOTHING',
        [initialDocument(this.facilityId)],
      );
      const document = await this.read();
      validate(document, this.facilityId);
      const tail = await this.pool.query<{ record: AuditRecord }>(
        'SELECT record FROM platform_audit ORDER BY sequence DESC LIMIT 1',
      );
      const last = tail.rows[0]?.record;
      if (
        (last?.hash ?? '0'.repeat(64)) !== document.auditHash ||
        (last?.sequence ?? 0) !== document.auditSequence ||
        (last && !verifyAudit([last], last.previousHash, last.sequence))
      )
        throw new Error('Audit head does not match persisted state.');
      this.healthy = true;
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  async transact<T>(operation: (document: PlatformDocument) => Change<T>): Promise<T> {
    if (!this.healthy) throw new Error('The database controller lease is unavailable.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const document = (
        await client.query<{ document: PlatformDocument }>(
          'SELECT document FROM platform_state WHERE id=1 FOR UPDATE',
        )
      ).rows[0].document;
      validate(document, this.facilityId);
      const result = operation(document);
      if (result.changed !== false) {
        document.revision++;
        for (const record of appendAudit(document, result.audit ?? []))
          await client.query('INSERT INTO platform_audit(sequence,record) VALUES($1,$2)', [
            record.sequence,
            record,
          ]);
        await client.query('UPDATE platform_state SET document=$1,updated_at=now() WHERE id=1', [
          document,
        ]);
      }
      await client.query('COMMIT');
      return result.value;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
  async read(): Promise<PlatformDocument> {
    const result = await this.pool.query<{ document: PlatformDocument }>(
      'SELECT document FROM platform_state WHERE id=1',
    );
    return result.rows[0].document;
  }
  async audit(after: number, limit: number): Promise<AuditRecord[]> {
    return (
      await this.pool.query<{ record: AuditRecord }>(
        'SELECT record FROM platform_audit WHERE sequence>$1 ORDER BY sequence LIMIT $2',
        [after, limit],
      )
    ).rows.map((r) => r.record);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.healthy = false;
    if (this.lease) {
      this.lease.release(true);
      this.lease = undefined;
    }
    await this.pool.end();
  }
}
