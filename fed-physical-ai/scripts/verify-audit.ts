import { readFile } from 'node:fs/promises';
import { verifyAudit, type AuditRecord } from '../src/platform/persistence.js';
if (!process.argv[2]) throw new Error('Usage: npm run audit:verify -- /path/to/audit-export.json');
const input = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
  records: AuditRecord[];
  truncated?: boolean;
};
if (!Array.isArray(input.records) || !verifyAudit(input.records))
  throw new Error('Audit verification failed. Check ordering, sequence and hashes.');
console.log(
  `Verified ${input.records.length} linked records from genesis. Head: ${input.records.at(-1)?.hash ?? '0'.repeat(64)}${input.truncated ? ' (partial export)' : ''}`,
);
