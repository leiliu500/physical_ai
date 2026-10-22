import { readFile } from 'node:fs/promises';
import { envelopeSchema } from '../src/platform/contracts.js';
import { signature } from '../src/platform/gateway.js';
const path = process.argv[2],
  secret = process.env.DEVICE_SECRET,
  origin = process.env.CONTROL_PLANE_URL;
if (!path || !secret || secret.length < 32 || !origin || new URL(origin).protocol !== 'https:')
  throw new Error(
    'Provide an observation JSON file, DEVICE_SECRET and an HTTPS CONTROL_PLANE_URL.',
  );
const raw = await readFile(path);
const observation = envelopeSchema.parse(JSON.parse(raw.toString('utf8')));
const response = await fetch(new URL('/api/device/telemetry', origin), {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Device-ID': observation.deviceId,
    'X-Device-Signature': signature(raw, secret),
  },
  body: raw,
  signal: AbortSignal.timeout(5000),
  redirect: 'error',
});
if (!response.ok)
  throw new Error(
    `Observation rejected (${response.status}). Check device credentials, source, sequence and clock.`,
  );
console.log(`Accepted device observation sequence ${observation.sequence}.`);
