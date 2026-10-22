import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DeviceCommand, GatewayAcknowledgement } from '../core/types.js';
import type { PlatformConfig } from './config.js';
import { acknowledgementSchema, HttpError } from './contracts.js';
export const signature = (raw: Buffer | string, secret: string): string =>
  'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
export function validSignature(raw: Buffer | string, provided: string, secret: string): boolean {
  if (!/^sha256=[a-f0-9]{64}$/.test(provided)) return false;
  return timingSafeEqual(
    Buffer.from(signature(raw, secret).slice(7), 'hex'),
    Buffer.from(provided.slice(7), 'hex'),
  );
}
export interface ExecutionGateway {
  send(command: DeviceCommand): Promise<GatewayAcknowledgement>;
}
export class HttpsExecutionGateway implements ExecutionGateway {
  constructor(private config: PlatformConfig) {}
  async send(command: DeviceCommand): Promise<GatewayAcknowledgement> {
    const device = this.config.devices[command.deviceId];
    if (!device?.commandEndpoint || !device.commandSecret)
      throw new HttpError(409, 'No execution endpoint is configured.');
    const payload = JSON.stringify({
      commandId: command.id,
      facilityId: this.config.facilityId,
      deviceId: command.deviceId,
      action: command.action,
      parameters: command.parameters,
      expiresAt: command.expiresAt,
      actor: command.createdBy,
      approvals: command.approvals,
    });
    const response = await fetch(device.commandEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': command.id,
        'X-Command-ID': command.id,
        'X-Control-Signature': signature(payload, device.commandSecret),
      },
      body: payload,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (!response.body) throw new Error('Execution gateway omitted its acknowledgement.');
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 16384) {
          await reader.cancel();
          throw new Error('Execution acknowledgement exceeded its limit.');
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const raw = Buffer.concat(chunks);
    if (!validSignature(raw, response.headers.get('X-Device-Signature') ?? '', device.secret))
      throw new Error('Execution acknowledgement signature is invalid.');
    const ack = acknowledgementSchema.parse(JSON.parse(raw.toString('utf8')));
    if (
      ack.commandId !== command.id ||
      ack.deviceId !== command.deviceId ||
      Math.abs(Date.now() - Date.parse(ack.timestamp)) > this.config.telemetryMaxAgeSeconds * 1000
    )
      throw new Error('Execution acknowledgement is stale or does not match its command.');
    if (!response.ok && !['failed', 'rejected'].includes(ack.status))
      throw new Error('Execution gateway returned an inconsistent result.');
    return ack;
  }
}
