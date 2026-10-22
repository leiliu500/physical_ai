import type { OperationsState } from '../core/types.js';
import type { PlatformConfig } from '../platform/config.js';
import { contextSchema, type AdvisorContext } from './contracts.js';
export function advisorContext(
  state: OperationsState,
  config: Pick<PlatformConfig, 'devices'>,
  source: AdvisorContext['source'],
): AdvisorContext {
  return contextSchema.parse({
    source,
    facilityId: state.facilityId,
    dispatchInhibited: state.dispatchInhibited,
    devices: Object.entries(config.devices)
      .slice(0, 40)
      .map(([id, device]) => ({
        id,
        kind: device.kind,
        observedAt: state.devices[id]?.observedAt ?? null,
        reading: state.devices[id]?.reading ?? null,
        destinations: device.destinations.slice(0, 50),
        capabilities: device.capabilities,
      })),
    reviews: state.proposals
      .filter((p) => p.status === 'pending')
      .slice(0, 40)
      .map((p) => ({
        id: p.id,
        deviceId: p.deviceId,
        action: p.action,
        title: p.title,
        approvals: p.approvals.length,
        requiredApprovals: p.requiredApprovals,
      })),
  });
}
