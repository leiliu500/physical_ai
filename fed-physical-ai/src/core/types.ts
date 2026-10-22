export type DeviceKind = 'robot' | 'processing-line' | 'environment' | 'inspection';
export type Action = 'transfer' | 'hold' | 'set-temperature' | 'quarantine';
export type Reading =
  | {
      kind: 'robot';
      status: 'idle' | 'moving' | 'charging' | 'fault';
      battery: number;
      position: { x: number; y: number; frame: string };
      safetyStop: boolean;
      interlockReady: boolean;
    }
  | {
      kind: 'processing-line';
      vibration: number;
      temperature: number;
      runState: 'running' | 'stopped' | 'fault';
    }
  | { kind: 'environment'; temperature: number; humidity: number }
  | {
      kind: 'inspection';
      inspectionId: string;
      bundleId: string;
      expectedCount: number;
      observedCount: number;
      confidence: number;
      modelId: string;
      modelVersion: string;
      artifactSha256: string;
    };
export interface Observation {
  deviceId: string;
  sequence: number;
  timestamp: string;
  reading: Reading;
}
export interface DeviceRecord {
  sequence: number;
  observedAt: string;
  receivedAt: string;
  reading: Reading;
  history: { timestamp: string; reading: Reading }[];
}
export type ProposalStatus = 'pending' | 'rejected' | 'queued' | 'resolved' | 'expired';
export interface Proposal {
  id: string;
  deviceId: string;
  action: Action;
  title: string;
  reading: Reading;
  readingDigest: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  requiredApprovals: number;
  approvals: string[];
  status: ProposalStatus;
  commandId?: string;
  reviewToken?: string;
}
export type CommandStatus =
  | 'queued'
  | 'dispatching'
  | 'accepted'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'uncertain'
  | 'cancelled'
  | 'expired';
export interface DeviceCommand {
  id: string;
  deviceId: string;
  action: Action;
  parameters: Record<string, string | number>;
  status: CommandStatus;
  createdAt: string;
  expiresAt: string;
  createdBy: string;
  approvals: string[];
  proposalId?: string;
  sentAt?: string;
  acknowledgedAt?: string;
  detail?: string;
}
export interface GatewayAcknowledgement {
  commandId: string;
  deviceId: string;
  status: 'accepted' | 'succeeded' | 'failed' | 'rejected';
  timestamp: string;
  detail?: string;
}
export interface OperationsState {
  version: 2;
  facilityId: string;
  dispatchInhibited: boolean;
  inhibitReason: string;
  devices: Record<string, DeviceRecord>;
  proposals: Proposal[];
  commands: DeviceCommand[];
  metrics: {
    acceptedObservations: number;
    completedTransfers: number;
    confirmedCommands: number;
    inspections: number;
  };
  inspectedIds: Record<string, number>;
}
export function emptyOperations(facilityId: string): OperationsState {
  return {
    version: 2,
    facilityId,
    dispatchInhibited: true,
    inhibitReason: 'Dispatch requires an authenticated safety release.',
    devices: {},
    proposals: [],
    commands: [],
    metrics: {
      acceptedObservations: 0,
      completedTransfers: 0,
      confirmedCommands: 0,
      inspections: 0,
    },
    inspectedIds: {},
  };
}
