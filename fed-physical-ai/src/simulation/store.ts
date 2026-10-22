import {
  appendAudit,
  initialDocument,
  type AuditRecord,
  type Change,
  type PlatformDocument,
} from '../platform/document.js';
import type { Store } from '../platform/persistence.js';

export class SimulationStore implements Store {
  readonly driver = 'simulation-memory';
  healthy = true;
  private document: PlatformDocument;
  private records: AuditRecord[] = [];
  constructor(facilityId: string) {
    this.document = initialDocument(facilityId);
  }
  async initialize(): Promise<void> {
    this.healthy = true;
  }
  async transact<T>(operation: (document: PlatformDocument) => Change<T>): Promise<T> {
    if (!this.healthy) throw new Error('Simulation store is closed.');
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
  get auditSize(): number {
    return this.records.length;
  }
}
