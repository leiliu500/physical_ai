import { randomUUID } from 'node:crypto';
import type {
  DeviceCommand,
  GatewayAcknowledgement,
  Observation,
  OperationsState,
  Proposal,
  Reading,
} from '../core/types.js';
import type { PlatformConfig } from './config.js';
import {
  acknowledgementEnvelopeSchema,
  authorize,
  commandSchema,
  envelopeSchema,
  HttpError,
  type Principal,
} from './contracts.js';
import { HttpsExecutionGateway, validSignature, type ExecutionGateway } from './gateway.js';
import { digest, type AuditInput, type PlatformDocument, type Store } from './document.js';
const active = (c: DeviceCommand): boolean =>
  ['queued', 'dispatching', 'accepted', 'uncertain'].includes(c.status);
export class Controller {
  private operational = false;
  private started = Date.now();
  private processing = false;
  private failure: string | null = null;
  private gateway: ExecutionGateway;
  constructor(
    readonly store: Store,
    readonly config: PlatformConfig,
    gateway?: ExecutionGateway,
  ) {
    this.gateway = gateway ?? new HttpsExecutionGateway(config);
  }
  get ready(): boolean {
    return this.operational && this.store.healthy;
  }
  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.store.transact((document) => {
      document.operations.dispatchInhibited = true;
      document.operations.inhibitReason = 'Controller recovery requires a fresh safety release.';
      for (const c of document.operations.commands) {
        if (c.status === 'dispatching') {
          c.status = 'uncertain';
          c.detail =
            'Controller restarted during transmission. Reconcile with the execution gateway.';
        } else if (c.status === 'queued') {
          c.status = 'cancelled';
          c.detail = 'Controller restart invalidated the prior dispatch authorization.';
        }
      }
      for (const p of document.operations.proposals) {
        if (p.status === 'pending') {
          p.approvals = [];
          p.revision++;
          p.updatedAt = new Date().toISOString();
        } else if (
          p.status === 'queued' &&
          document.operations.commands.find((c) => c.id === p.commandId)?.status === 'cancelled'
        )
          p.status = 'expired';
      }
      return {
        value: undefined,
        audit: [
          this.audit('system', 'controller.started', 'startup', {
            facilityId: this.config.facilityId,
            policy: this.config.policy,
            models: this.config.models,
            devices: Object.fromEntries(
              Object.entries(this.config.devices).map(([id, device]) => [
                id,
                {
                  kind: device.kind,
                  required: device.required,
                  capabilities: device.capabilities,
                  destinations: device.destinations,
                  executionConfigured: Boolean(device.commandEndpoint),
                },
              ]),
            ),
          }),
        ],
      };
    });
    this.operational = true;
  }
  private audit(
    actor: string,
    action: string,
    requestId: string,
    details: Record<string, unknown>,
  ): AuditInput {
    return { actor, action, requestId, details };
  }
  private token(p: Proposal): string {
    return digest({
      id: p.id,
      revision: p.revision,
      evidence: p.readingDigest,
      policy: this.config.policy,
    });
  }
  private publish(document: PlatformDocument): OperationsState {
    const state = structuredClone(document.operations);
    for (const p of state.proposals) p.reviewToken = this.token(p);
    return state;
  }
  async state(): Promise<OperationsState> {
    if (!this.ready) throw new HttpError(503, 'Controller is not ready.');
    return this.publish(await this.store.read());
  }
  private fresh(state: OperationsState, id: string): boolean {
    const record = state.devices[id];
    return (
      Boolean(record) &&
      Date.now() - Date.parse(record.observedAt) <= this.config.telemetryMaxAgeSeconds * 1000
    );
  }
  private ensureDevice(state: OperationsState, id: string, action?: DeviceCommand['action']): void {
    const device = Object.hasOwn(this.config.devices, id) ? this.config.devices[id] : undefined;
    if (!device) throw new HttpError(404, 'Device is not registered.');
    if (!this.fresh(state, id)) throw new HttpError(409, 'Fresh device observations are required.');
    if (
      action &&
      (!device.commandEndpoint || !device.commandSecret || !device.capabilities.includes(action))
    )
      throw new HttpError(
        409,
        'The device has no authorized execution capability for this action.',
      );
    const reading = state.devices[id].reading;
    if (reading.kind !== device.kind)
      throw new HttpError(
        409,
        'A new observation matching the current device configuration is required.',
      );
    if (reading.kind === 'inspection') {
      const model = this.config.models[reading.modelId];
      if (
        !model?.approved ||
        model.version !== reading.modelVersion ||
        model.artifactSha256 !== reading.artifactSha256
      )
        throw new HttpError(409, 'Current inspection model provenance is not approved.');
    }
    if (
      reading.kind === 'robot' &&
      (reading.safetyStop ||
        !reading.interlockReady ||
        reading.status === 'fault' ||
        reading.battery < this.config.policy.minimumRobotBattery)
    )
      throw new HttpError(409, 'Robot safety interlocks or battery policy prohibit dispatch.');
  }
  private ensureRelease(state: OperationsState): void {
    const ids = Object.entries(this.config.devices)
      .filter(([, d]) => d.required)
      .map(([id]) => id);
    if (!ids.length) throw new HttpError(409, 'At least one required device must be registered.');
    for (const id of ids) this.ensureDevice(state, id);
    if (state.commands.some((c) => c.status === 'uncertain'))
      throw new HttpError(
        409,
        'Uncertain commands must be reconciled before dispatch is released.',
      );
  }
  private queue(
    state: OperationsState,
    deviceId: string,
    action: DeviceCommand['action'],
    parameters: DeviceCommand['parameters'],
    actor: string,
    approvals: string[],
    proposalId?: string,
  ): DeviceCommand {
    if (state.dispatchInhibited) throw new HttpError(409, 'Dispatch is inhibited.');
    this.ensureRelease(state);
    this.ensureDevice(state, deviceId, action);
    if (state.commands.some((c) => c.deviceId === deviceId && active(c)))
      throw new HttpError(409, 'This device already has an active or uncertain command.');
    const command: DeviceCommand = {
      id: randomUUID(),
      deviceId,
      action,
      parameters,
      createdBy: actor,
      approvals,
      status: 'queued',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.config.policy.commandTtlSeconds * 1000).toISOString(),
      ...(proposalId ? { proposalId } : {}),
    };
    state.commands.push(command);
    return command;
  }
  async execute(
    input: unknown,
    principal: Principal,
    requestId: string,
    key?: string,
  ): Promise<OperationsState> {
    const command = commandSchema.parse(input);
    authorize(principal, command.command);
    if (!this.ready) throw new HttpError(503, 'Controller is not ready.');
    if (!key || !/^[a-zA-Z0-9_-]{16,128}$/.test(key))
      throw new HttpError(400, 'A valid Idempotency-Key is required.');
    const receiptId = digest({ actor: principal.subject, key }),
      requestDigest = digest(command);
    return this.store.transact((document) => {
      const now = Date.now();
      for (const [id, r] of Object.entries(document.receipts))
        if (r.expiresAt <= now) delete document.receipts[id];
      const existing = document.receipts[receiptId];
      if (existing) {
        if (existing.digest !== requestDigest)
          throw new HttpError(409, 'Idempotency key conflicts with an earlier request.');
        return { value: this.publish(document), changed: false };
      }
      if (Object.keys(document.receipts).length >= 10000)
        throw new HttpError(503, 'Idempotency capacity is exhausted.');
      const state = document.operations;
      if (command.command === 'inhibit') {
        state.dispatchInhibited = true;
        state.inhibitReason = command.data.reason;
        for (const c of state.commands)
          if (c.status === 'queued') {
            c.status = 'cancelled';
            c.detail = 'Dispatch inhibited before transmission.';
          }
      }
      if (command.command === 'release-inhibit') {
        this.ensureRelease(state);
        state.dispatchInhibited = false;
        state.inhibitReason = '';
      }
      if (command.command === 'transfer') {
        const device = this.config.devices[command.data.deviceId];
        if (
          !device ||
          device.kind !== 'robot' ||
          !device.destinations.includes(command.data.destination)
        )
          throw new HttpError(409, 'Destination is not authorized for this robot.');
        const reading = state.devices[command.data.deviceId]?.reading;
        if (reading?.kind === 'robot' && reading.status !== 'idle')
          throw new HttpError(409, 'Robot must report idle before a transfer.');
        this.queue(
          state,
          command.data.deviceId,
          'transfer',
          { destination: command.data.destination, reference: command.data.reference },
          principal.subject,
          [],
        );
      }
      if (command.command === 'review') {
        const p = state.proposals.find((p) => p.id === command.data.id && p.status === 'pending');
        if (!p) throw new HttpError(404, 'Pending review not found.');
        if (this.token(p) !== command.data.reviewToken)
          throw new HttpError(409, 'Review evidence changed. Refresh the current state.');
        if (command.data.action === 'reject') p.status = 'rejected';
        else if (command.data.action === 'refresh') {
          this.ensureDevice(state, p.deviceId);
          p.reading = structuredClone(state.devices[p.deviceId].reading);
          p.readingDigest = digest(p.reading);
          p.approvals = [];
          p.revision++;
          p.updatedAt = new Date().toISOString();
        } else {
          if (now - Date.parse(p.updatedAt) > this.config.policy.reviewTtlSeconds * 1000)
            throw new HttpError(409, 'Review expired. Refresh the evidence.');
          this.ensureDevice(state, p.deviceId, p.action);
          if (digest(state.devices[p.deviceId].reading) !== p.readingDigest)
            throw new HttpError(409, 'Device evidence changed.');
          if (p.approvals.includes(principal.subject))
            throw new HttpError(409, 'A distinct authenticated reviewer is required.');
          p.approvals.push(principal.subject);
          if (p.approvals.length === p.requiredApprovals) {
            const parameters: Record<string, string | number> =
              p.action === 'set-temperature'
                ? { setpoint: this.config.policy.coolingSetpoint }
                : p.reading.kind === 'inspection'
                  ? { bundleId: p.reading.bundleId, inspectionId: p.reading.inspectionId }
                  : {};
            const c = this.queue(
              state,
              p.deviceId,
              p.action,
              parameters,
              principal.subject,
              [...p.approvals],
              p.id,
            );
            p.status = 'queued';
            p.commandId = c.id;
          }
        }
      }
      document.receipts[receiptId] = { digest: requestDigest, expiresAt: now + 3600000 };
      this.trim(state);
      return {
        value: this.publish(document),
        audit: [
          this.audit(principal.subject, 'operator.' + command.command, requestId, {
            ...command,
            policyDigest: digest(this.config.policy),
          }),
        ],
      };
    });
  }
  private trim(state: OperationsState): void {
    state.commands = [
      ...state.commands.filter(active),
      ...state.commands.filter((c) => !active(c)).slice(-500),
    ];
    state.proposals = [
      ...state.proposals.filter((p) => ['pending', 'queued'].includes(p.status)),
      ...state.proposals.filter((p) => !['pending', 'queued'].includes(p.status)).slice(-500),
    ];
    if (state.commands.filter(active).length > 1000)
      throw new HttpError(503, 'Active command capacity reached.');
  }
  verifyDevice(
    raw: Buffer,
    id: string,
    provided: string,
    acknowledgement = false,
  ): Observation | ReturnType<typeof acknowledgementEnvelopeSchema.parse> {
    const device = Object.hasOwn(this.config.devices, id) ? this.config.devices[id] : undefined;
    if (!device || !validSignature(raw, provided, device.secret))
      throw new HttpError(401, 'Invalid device identity or signature.');
    let value: unknown;
    try {
      value = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON.');
    }
    const envelope = acknowledgement
      ? acknowledgementEnvelopeSchema.parse(value)
      : envelopeSchema.parse(value);
    if (envelope.deviceId !== id)
      throw new HttpError(403, 'Device identity does not match its envelope.');
    const age = Date.now() - Date.parse(envelope.timestamp);
    if (age > this.config.telemetryMaxAgeSeconds * 1000 || age < -5000)
      throw new HttpError(409, 'Device message is stale or too far in the future.');
    if ('reading' in envelope) {
      if (envelope.reading.kind !== device.kind)
        throw new HttpError(403, 'Observation kind is not authorized for this device.');
      if (envelope.reading.kind === 'inspection') {
        const r = envelope.reading,
          m = this.config.models[r.modelId];
        if (!m?.approved || m.version !== r.modelVersion || m.artifactSha256 !== r.artifactSha256)
          throw new HttpError(409, 'Inspection model provenance is not approved.');
      }
    } else {
      const ackAge = Date.now() - Date.parse(envelope.acknowledgement.timestamp);
      if (ackAge > this.config.telemetryMaxAgeSeconds * 1000 || ackAge < -5000)
        throw new HttpError(409, 'Acknowledgement timestamp is stale or too far in the future.');
    }
    return envelope;
  }
  private sequence(
    document: PlatformDocument,
    envelope: { deviceId: string; sequence: number; timestamp: string },
  ): void {
    const prior = document.deviceSequences[envelope.deviceId];
    if (
      prior &&
      (envelope.sequence <= prior.sequence ||
        Date.parse(envelope.timestamp) < Date.parse(prior.observedAt))
    )
      throw new HttpError(409, 'Device sequence or timestamp was replayed.');
    document.deviceSequences[envelope.deviceId] = {
      sequence: envelope.sequence,
      observedAt: envelope.timestamp,
    };
  }
  async ingest(
    envelope: ReturnType<Controller['verifyDevice']>,
    requestId: string,
  ): Promise<{ accepted: true; sequence: number }> {
    if (!this.ready) throw new HttpError(503, 'Controller is not ready.');
    return this.store.transact((document) => {
      this.sequence(document, envelope);
      const state = document.operations;
      if ('acknowledgement' in envelope) {
        if (envelope.acknowledgement.deviceId !== envelope.deviceId)
          throw new HttpError(403, 'Acknowledgement identity mismatch.');
        this.applyAcknowledgement(state, envelope.acknowledgement);
      } else {
        const old = state.devices[envelope.deviceId];
        state.devices[envelope.deviceId] = {
          sequence: envelope.sequence,
          observedAt: envelope.timestamp,
          receivedAt: new Date().toISOString(),
          reading: envelope.reading,
          history: [
            ...(old?.history ?? []),
            { timestamp: envelope.timestamp, reading: envelope.reading },
          ].slice(-60),
        };
        state.metrics.acceptedObservations++;
        if (envelope.reading.kind === 'inspection') {
          const id = envelope.reading.inspectionId;
          for (const [key, seen] of Object.entries(state.inspectedIds))
            if (seen < Date.now() - 86400000) delete state.inspectedIds[key];
          if (!state.inspectedIds[id]) {
            if (Object.keys(state.inspectedIds).length >= 10000)
              throw new HttpError(503, 'Inspection deduplication capacity reached.');
            state.inspectedIds[id] = Date.now();
            state.metrics.inspections++;
          }
        }
        this.evaluate(state, envelope.deviceId, envelope.reading);
      }
      this.trim(state);
      return {
        value: { accepted: true as const, sequence: envelope.sequence },
        audit: [
          this.audit(
            'device:' + envelope.deviceId,
            'acknowledgement' in envelope ? 'device.acknowledged' : 'device.observed',
            requestId,
            { ...envelope },
          ),
        ],
      };
    });
  }
  private evaluate(state: OperationsState, deviceId: string, reading: Reading): void {
    let action: Proposal['action'] | undefined,
      title = '';
    const policy = this.config.policy;
    if (
      reading.kind === 'processing-line' &&
      (reading.vibration > policy.vibrationMax ||
        reading.temperature > policy.lineTemperatureMax ||
        reading.runState === 'fault')
    ) {
      action = 'hold';
      title = 'Review processing-line hold';
    }
    if (reading.kind === 'environment' && reading.temperature > policy.zoneTemperatureMax) {
      action = 'set-temperature';
      title = 'Review zone temperature response';
    }
    if (
      reading.kind === 'inspection' &&
      (reading.expectedCount !== reading.observedCount ||
        reading.confidence < policy.minimumInspectionConfidence)
    ) {
      action = 'quarantine';
      title = 'Review inspection exception';
    }
    const pending = state.proposals.find((p) => p.deviceId === deviceId && p.status === 'pending');
    if (!action) {
      if (pending) pending.status = 'resolved';
      return;
    }
    if (pending) {
      if (pending.readingDigest !== digest(reading)) {
        pending.reading = structuredClone(reading);
        pending.readingDigest = digest(reading);
        pending.approvals = [];
        pending.revision++;
        pending.updatedAt = new Date().toISOString();
      }
      return;
    }
    state.proposals.push({
      id: randomUUID(),
      deviceId,
      action,
      title,
      reading: structuredClone(reading),
      readingDigest: digest(reading),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revision: 1,
      requiredApprovals: action === 'quarantine' ? 2 : 1,
      approvals: [],
      status: 'pending',
    });
  }
  private applyAcknowledgement(state: OperationsState, ack: GatewayAcknowledgement): void {
    const command = state.commands.find(
      (c) => c.id === ack.commandId && c.deviceId === ack.deviceId,
    );
    if (!command) throw new HttpError(404, 'Acknowledgement command not found.');
    if (!['dispatching', 'accepted', 'uncertain'].includes(command.status)) {
      if (command.status === ack.status) return;
      throw new HttpError(409, 'Command cannot accept this acknowledgement.');
    }
    if (Date.parse(ack.timestamp) < Date.parse(command.sentAt ?? command.createdAt) - 5000)
      throw new HttpError(409, 'Acknowledgement predates dispatch.');
    command.status = ack.status;
    command.acknowledgedAt = ack.timestamp;
    command.detail = ack.detail;
    if (ack.status === 'succeeded') {
      state.metrics.confirmedCommands++;
      if (command.action === 'transfer') state.metrics.completedTransfers++;
    }
    if (ack.status !== 'accepted') {
      const p = state.proposals.find((p) => p.commandId === command.id);
      if (p) p.status = ack.status === 'succeeded' ? 'resolved' : 'rejected';
    }
  }
  async processOutbox(): Promise<void> {
    if (!this.ready || this.processing) return;
    this.processing = true;
    try {
      const next = await this.store.transact((document) => {
        const state = document.operations;
        const overdue = state.commands.filter(
          (c) => c.status === 'accepted' && Date.parse(c.expiresAt) <= Date.now(),
        );
        if (overdue.length) {
          for (const c of overdue) {
            c.status = 'uncertain';
            c.detail =
              'Completion was not confirmed within the command deadline. Reconcile with the execution gateway.';
          }
          state.dispatchInhibited = true;
          state.inhibitReason = 'Command completion deadline exceeded.';
          for (const c of state.commands) if (c.status === 'queued') c.status = 'cancelled';
          return {
            value: null,
            audit: [
              this.audit('system', 'command.completion-overdue', 'watchdog', {
                commandIds: overdue.map((c) => c.id),
              }),
            ],
          };
        }
        if (!state.dispatchInhibited) {
          try {
            this.ensureRelease(state);
          } catch (e) {
            state.dispatchInhibited = true;
            state.inhibitReason =
              e instanceof Error ? e.message : 'Safety release conditions no longer hold.';
            for (const c of state.commands) if (c.status === 'queued') c.status = 'cancelled';
            return {
              value: null,
              audit: [
                this.audit('system', 'dispatch.interlocked', 'watchdog', {
                  reason: state.inhibitReason,
                }),
              ],
            };
          }
        }
        const command = state.commands.find((c) => c.status === 'queued');
        if (!command) return { value: null, changed: false };
        if (Date.parse(command.expiresAt) <= Date.now()) {
          command.status = 'expired';
          return {
            value: null,
            audit: [this.audit('system', 'command.expired', 'outbox', { commandId: command.id })],
          };
        }
        try {
          if (state.dispatchInhibited) throw new HttpError(409, 'Dispatch is inhibited.');
          this.ensureRelease(state);
          this.ensureDevice(state, command.deviceId, command.action);
          if (command.action === 'transfer') {
            const r = state.devices[command.deviceId].reading;
            if (
              r.kind !== 'robot' ||
              r.status !== 'idle' ||
              !this.config.devices[command.deviceId].destinations.includes(
                String(command.parameters.destination),
              )
            )
              throw new HttpError(409, 'Robot state or destination authorization changed.');
          }
          if (command.proposalId) {
            const p = state.proposals.find((p) => p.id === command.proposalId);
            if (!p || digest(state.devices[command.deviceId].reading) !== p.readingDigest)
              throw new HttpError(409, 'Approved evidence changed before transmission.');
          }
        } catch (e) {
          command.status = 'cancelled';
          command.detail = e instanceof Error ? e.message : 'Dispatch policy rejected the command.';
          return {
            value: null,
            audit: [
              this.audit('system', 'command.cancelled', 'outbox', {
                commandId: command.id,
                reason: command.detail,
              }),
            ],
          };
        }
        command.status = 'dispatching';
        command.sentAt = new Date().toISOString();
        return {
          value: structuredClone(command),
          audit: [
            this.audit('system', 'command.dispatched', 'outbox', {
              commandId: command.id,
              deviceId: command.deviceId,
              action: command.action,
            }),
          ],
        };
      });
      if (next) {
        let acknowledgement: GatewayAcknowledgement | undefined;
        try {
          acknowledgement = await this.gateway.send(next);
        } catch {
          /* A network failure cannot establish whether an action happened. */
        }
        await this.store.transact((document) => {
          const current = document.operations.commands.find((c) => c.id === next.id);
          if (!current || !['dispatching', 'accepted', 'uncertain'].includes(current.status))
            return { value: undefined, changed: false };
          if (acknowledgement) this.applyAcknowledgement(document.operations, acknowledgement);
          else if (current.status === 'dispatching') {
            current.status = 'uncertain';
            current.detail =
              'Delivery outcome is unknown. Reconcile with the execution gateway before retrying.';
            document.operations.dispatchInhibited = true;
            document.operations.inhibitReason =
              'Uncertain execution outcome requires reconciliation.';
          }
          return {
            value: undefined,
            audit: [
              this.audit(
                'system',
                acknowledgement ? 'command.gateway-acknowledged' : 'command.uncertain',
                'outbox',
                { commandId: next.id, status: current.status },
              ),
            ],
          };
        });
      }
    } catch {
      this.operational = false;
      this.failure =
        'Durable command processing failed. Dispatch is inhibited until storage is repaired and the controller is restarted.';
    } finally {
      this.processing = false;
    }
  }
  async status(): Promise<Record<string, unknown>> {
    const document = await this.store.read(),
      state = document.operations;
    return {
      version: '2.0.0',
      facilityId: this.config.facilityId,
      ready: this.ready,
      uptimeSeconds: Math.floor((Date.now() - this.started) / 1000),
      revision: document.revision,
      authentication: 'oidc',
      persistence: 'postgres',
      dispatchInhibited: state.dispatchInhibited,
      inhibitReason: state.inhibitReason,
      audit: { sequence: document.auditSequence, head: document.auditHash },
      devices: Object.entries(this.config.devices).map(([id, d]) => ({
        id,
        kind: d.kind,
        required: d.required,
        capabilities: d.capabilities,
        destinations: d.destinations,
        executionConfigured: Boolean(d.commandEndpoint),
        status: !state.devices[id] ? 'awaiting data' : this.fresh(state, id) ? 'online' : 'stale',
        observedAt: state.devices[id]?.observedAt ?? null,
      })),
      models: Object.entries(this.config.models).map(([id, m]) => ({ id, ...m })),
      policy: this.config.policy,
      policyDigest: digest(this.config.policy),
      lastFailure: this.failure,
    };
  }
  async close(): Promise<void> {
    this.operational = false;
    await this.store.close();
  }
}
