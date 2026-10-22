import { createHash } from 'node:crypto';
import { emptyOperations, type OperationsState } from '../core/types.js';
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
      .join(',') +
    '}'
  );
}
export const digest = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
export interface Receipt {
  digest: string;
  expiresAt: number;
}
export interface PlatformDocument {
  schemaVersion: 2;
  revision: number;
  operations: OperationsState;
  receipts: Record<string, Receipt>;
  deviceSequences: Record<string, { sequence: number; observedAt: string }>;
  auditSequence: number;
  auditHash: string;
}
export interface AuditInput {
  actor: string;
  action: string;
  requestId: string;
  details: Record<string, unknown>;
}
export interface AuditRecord extends AuditInput {
  sequence: number;
  timestamp: string;
  previousHash: string;
  hash: string;
}
export interface Change<T> {
  value: T;
  audit?: AuditInput[];
  changed?: boolean;
}
export interface Store {
  readonly driver: string;
  readonly healthy: boolean;
  initialize(): Promise<void>;
  transact<T>(operation: (document: PlatformDocument) => Change<T>): Promise<T>;
  read(): Promise<PlatformDocument>;
  audit(after: number, limit: number): Promise<AuditRecord[]>;
  close(): Promise<void>;
}
export function initialDocument(facilityId: string): PlatformDocument {
  return {
    schemaVersion: 2,
    revision: 0,
    operations: emptyOperations(facilityId),
    receipts: {},
    deviceSequences: {},
    auditSequence: 0,
    auditHash: '0'.repeat(64),
  };
}
export function appendAudit(document: PlatformDocument, inputs: AuditInput[]): AuditRecord[] {
  return inputs.map((input) => {
    const body = {
      ...input,
      sequence: ++document.auditSequence,
      timestamp: new Date().toISOString(),
      previousHash: document.auditHash,
    };
    const record = { ...body, hash: digest(body) };
    document.auditHash = record.hash;
    return record;
  });
}
export function verifyAudit(
  records: AuditRecord[],
  previousHash = '0'.repeat(64),
  sequence = 1,
): boolean {
  for (const record of records) {
    const { hash, ...body } = record;
    if (
      record.sequence !== sequence++ ||
      record.previousHash !== previousHash ||
      digest(body) !== hash
    )
      return false;
    previousHash = hash;
  }
  return true;
}
