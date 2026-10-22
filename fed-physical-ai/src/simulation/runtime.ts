import { randomUUID } from 'node:crypto';
import type { DeviceCommand, GatewayAcknowledgement, Reading } from '../core/types.js';
import { Controller } from '../platform/controller.js';
import type { Principal } from '../platform/contracts.js';
import { HttpError } from '../platform/contracts.js';
import { signature, type ExecutionGateway } from '../platform/gateway.js';
import { digest } from '../platform/document.js';
import { locations, robotIds, simulationConfig } from './config.js';
import { SimulationStore } from './store.js';

export type Scenario = 'normal' | 'equipment' | 'temperature' | 'inspection' | 'interlock';
export interface SimulationEvent {
  id: number;
  timestamp: string;
  message: string;
  category: 'telemetry' | 'transfer' | 'inspection' | 'review' | 'safety' | 'system';
}
export interface SimulationStatus {
  running: boolean;
  elapsedSeconds: number;
  reviewer: 'a' | 'b';
  scenario: Scenario;
  events: SimulationEvent[];
  automaticTransfers: boolean;
  retentionLimit: number;
}
interface Flight {
  command: DeviceCommand;
  started: number;
  duration: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
}
class SimulationGateway implements ExecutionGateway {
  readonly flights = new Map<string, Flight>();
  constructor(
    private clock: () => number,
    private position: (id: string) => { x: number; y: number },
    private event: (message: string) => void,
  ) {}
  async send(command: DeviceCommand): Promise<GatewayAcknowledgement> {
    if (!command.deviceId.startsWith('SIM-'))
      throw new Error('Simulation gateway rejects physical device identifiers.');
    const from = this.position(command.deviceId),
      to = locations[String(command.parameters.destination)] ?? from;
    this.flights.set(command.id, {
      command,
      started: this.clock(),
      duration: command.action === 'transfer' ? 9 : 3,
      from,
      to,
    });
    this.event(`${command.deviceId}: ${command.action} accepted by the simulated gateway.`);
    return {
      commandId: command.id,
      deviceId: command.deviceId,
      status: 'accepted',
      timestamp: new Date().toISOString(),
      detail: 'Simulation gateway accepted; completion pending.',
    };
  }
}
export class SimulationRuntime {
  readonly config = simulationConfig();
  private store!: SimulationStore;
  private controller!: Controller;
  private gateway!: SimulationGateway;
  private lane: Promise<unknown> = Promise.resolve();
  private started = false;
  private elapsed = 0;
  private running = true;
  private reviewer: 'a' | 'b' = 'a';
  private scenario: Scenario = 'normal';
  private events: SimulationEvent[] = [];
  private eventId = 0;
  private observations = new Map<string, number>();
  private positions = new Map<string, { x: number; y: number }>();
  private inspection!: Extract<Reading, { kind: 'inspection' }>;
  private lineHeld = false;
  private cooled = false;
  private quarantined = false;
  private autoTransfers = true;
  private automaticCycle = true;
  private nextAutoTransfer = 12;
  private nextInspection = 8;
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lane.then(operation);
    this.lane = next.catch(() => undefined);
    return next;
  }
  private event(message: string, category: SimulationEvent['category'] = 'system'): void {
    this.events.unshift({
      id: ++this.eventId,
      timestamp: new Date().toISOString(),
      message,
      category,
    });
    this.events = this.events.slice(0, 80);
  }
  private actor(): Principal {
    return {
      subject: `simulation:reviewer-${this.reviewer}`,
      name: `Simulated reviewer ${this.reviewer.toUpperCase()}`,
      roles: ['supervisor'],
      authentication: 'simulation',
    };
  }
  private async command(
    command: string,
    data: Record<string, unknown>,
    actor = this.actor(),
  ): Promise<unknown> {
    return this.controller.execute({ command, data }, actor, randomUUID(), randomUUID());
  }
  private newInspection(exception: boolean): void {
    this.inspection = {
      kind: 'inspection',
      inspectionId: randomUUID(),
      bundleId: `SIM-BUNDLE-${String(Math.floor(this.elapsed / 8) + 1).padStart(5, '0')}`,
      expectedCount: 1000,
      observedCount: exception ? 998 : 1000,
      confidence: exception ? 0.955 : 0.997,
      modelId: 'SIM-vision',
      modelVersion: 'synthetic-1',
      artifactSha256: this.config.models['SIM-vision'].artifactSha256,
    };
  }
  private async observe(id: string, reading: Reading): Promise<void> {
    const sequence = (this.observations.get(id) ?? 0) + 1;
    this.observations.set(id, sequence);
    const raw = Buffer.from(
      JSON.stringify({ deviceId: id, sequence, timestamp: new Date().toISOString(), reading }),
    );
    await this.controller.ingest(
      this.controller.verifyDevice(raw, id, signature(raw, this.config.devices[id].secret)),
      randomUUID(),
    );
  }
  private async acknowledge(command: DeviceCommand): Promise<void> {
    const sequence = (this.observations.get(command.deviceId) ?? 0) + 1;
    this.observations.set(command.deviceId, sequence);
    const raw = Buffer.from(
      JSON.stringify({
        deviceId: command.deviceId,
        sequence,
        timestamp: new Date().toISOString(),
        acknowledgement: {
          commandId: command.id,
          deviceId: command.deviceId,
          status: 'succeeded',
          timestamp: new Date().toISOString(),
          detail: 'Simulated completion; no physical equipment was actuated.',
        },
      }),
    );
    await this.controller.ingest(
      this.controller.verifyDevice(
        raw,
        command.deviceId,
        signature(raw, this.config.devices[command.deviceId].secret),
        true,
      ),
      randomUUID(),
    );
    this.event(
      `${command.deviceId}: ${command.action} completed and acknowledged in simulation.`,
      command.action === 'transfer' ? 'transfer' : 'review',
    );
  }
  private async initialize(): Promise<void> {
    if (this.started) return;
    this.store = new SimulationStore(this.config.facilityId);
    robotIds.forEach((id, i) => this.positions.set(id, { x: 90 + i * 250, y: 140 }));
    this.gateway = new SimulationGateway(
      () => this.elapsed,
      (id) => this.positions.get(id) ?? { x: 0, y: 0 },
      (message) => this.event(message, 'transfer'),
    );
    this.controller = new Controller(this.store, this.config, this.gateway);
    await this.controller.initialize();
    this.started = true;
    this.newInspection(true);
    this.event(
      'Browser-local simulation started. All devices, identities and outcomes are synthetic.',
    );
    await this.emitObservations();
    await this.command('release-inhibit', {
      reason: 'Isolated simulation started with synthetic required-device observations.',
    });
    this.event('Simulation dispatch released after controller interlock checks.', 'safety');
    for (let i = 0; i < robotIds.length; i++) {
      await this.command('transfer', {
        deviceId: robotIds[i],
        destination: Object.keys(locations)[(i + 1) % 3],
        reference: 'SIM-INITIAL-' + (i + 1),
      });
      await this.controller.processOutbox();
    }
    this.event(
      'Inspection count and confidence exception requires two simulated reviewers.',
      'inspection',
    );
    await this.emitObservations();
  }
  private async emitObservations(): Promise<void> {
    for (const [index, id] of robotIds.entries()) {
      const flight = [...this.gateway.flights.values()].find((f) => f.command.deviceId === id),
        p = this.positions.get(id)!;
      await this.observe(id, {
        kind: 'robot',
        status: flight ? 'moving' : 'idle',
        battery: Number((94 - index * 11 - (this.elapsed % 120) * 0.04).toFixed(1)),
        position: { ...p, frame: 'SIM-facility-map' },
        safetyStop: this.scenario === 'interlock' && index === 0,
        interlockReady: !(this.scenario === 'interlock' && index === 0),
      });
    }
    const equipment = this.scenario === 'equipment',
      hot = this.scenario === 'temperature';
    await this.observe('SIM-LINE-01', {
      kind: 'processing-line',
      vibration: this.lineHeld
        ? 0.25
        : equipment
          ? 7.1
          : Number((2.2 + Math.sin(this.elapsed / 3) * 0.35).toFixed(2)),
      temperature:
        equipment && !this.lineHeld
          ? 72
          : Number((48 + Math.sin(this.elapsed / 7) * 1.3).toFixed(1)),
      runState: this.lineHeld ? 'stopped' : 'running',
    });
    await this.observe('SIM-HVAC-01', {
      kind: 'environment',
      temperature:
        hot && !this.cooled ? 30.4 : Number((22.1 + Math.sin(this.elapsed / 9) * 0.6).toFixed(1)),
      humidity: Number((44 + Math.sin(this.elapsed / 8) * 2.5).toFixed(1)),
    });
    await this.observe('SIM-VISION-01', this.inspection);
  }
  private async advance(): Promise<void> {
    this.elapsed++;
    for (const [id, flight] of this.gateway.flights) {
      if (this.scenario === 'interlock' && flight.command.deviceId === robotIds[0]) {
        flight.started++;
        continue;
      }
      const fraction = Math.min(1, (this.elapsed - flight.started) / flight.duration);
      if (flight.command.action === 'transfer')
        this.positions.set(flight.command.deviceId, {
          x: Number((flight.from.x + (flight.to.x - flight.from.x) * fraction).toFixed(1)),
          y: flight.from.y,
        });
      if (fraction === 1) {
        await this.acknowledge(flight.command);
        this.gateway.flights.delete(id);
        if (flight.command.action === 'hold') this.lineHeld = true;
        if (flight.command.action === 'set-temperature') this.cooled = true;
        if (flight.command.action === 'quarantine') {
          this.quarantined = true;
          this.newInspection(false);
        }
      }
    }
    if (this.automaticCycle && this.elapsed === 18) {
      this.scenario = 'equipment';
      this.event('Vibration and equipment temperature crossed the simulation policy.', 'safety');
    }
    if (this.automaticCycle && this.elapsed === 38) {
      this.scenario = 'temperature';
      this.event('Simulated vault zone temperature requires a reviewed response.', 'safety');
    }
    const before = await this.controller.state();
    const inspectionOpen = before.proposals.some(
      (p) => p.deviceId === 'SIM-VISION-01' && ['pending', 'queued'].includes(p.status),
    );
    if (this.elapsed >= this.nextInspection && !inspectionOpen) {
      this.newInspection(this.scenario === 'inspection' && !this.quarantined);
      this.nextInspection = this.elapsed + 8;
      this.event(
        `${this.inspection.bundleId}: ${this.inspection.observedCount}/${this.inspection.expectedCount} items reported by synthetic vision.`,
        'inspection',
      );
    }
    await this.emitObservations();
    await this.controller.processOutbox();
    const state = await this.controller.state();
    if (this.autoTransfers && this.elapsed >= this.nextAutoTransfer && !state.dispatchInhibited) {
      const robot = robotIds.find(
        (id) =>
          !state.commands.some(
            (c) =>
              c.deviceId === id &&
              ['queued', 'dispatching', 'accepted', 'uncertain'].includes(c.status),
          ),
      );
      if (robot) {
        const p = this.positions.get(robot)!;
        const destination = Object.entries(locations).find(
          ([, location]) => location.x !== p.x,
        )![0];
        await this.command('transfer', {
          deviceId: robot,
          destination,
          reference: 'SIM-AUTO-' + this.elapsed,
        });
        await this.controller.processOutbox();
        this.nextAutoTransfer = this.elapsed + 6;
      }
    }
    if (this.elapsed % 5 === 0)
      this.event(
        `Six simulated devices published verified observations at t+${this.elapsed}s.`,
        'telemetry',
      );
    if (this.store.auditSize >= 6000) {
      this.running = false;
      this.event('Session retention limit reached. Reset the simulation to start a fresh run.');
    }
  }
  async tick(force = false): Promise<void> {
    return this.serialize(async () => {
      await this.initialize();
      if (this.running || force) await this.advance();
    });
  }
  async request(path: string, data?: unknown): Promise<unknown> {
    return this.serialize(async () => {
      await this.initialize();
      const url = new URL(path, 'https://simulation.invalid');
      if (url.pathname === '/api/config')
        return {
          version: '2.1.0',
          facilityId: this.config.facilityId,
          authentication: 'simulation',
          mode: 'simulation',
        };
      if (url.pathname === '/api/session') return { ...this.actor(), csrf: null };
      if (url.pathname === '/api/state') return this.controller.state();
      if (url.pathname === '/api/platform')
        return {
          ...(await this.controller.status()),
          version: '2.1.0',
          authentication: 'simulation',
          persistence: 'browser-session-memory',
          simulation: {
            running: this.running,
            elapsedSeconds: this.elapsed,
            reviewer: this.reviewer,
            scenario: this.scenario,
            events: this.events,
            automaticTransfers: this.autoTransfers,
            retentionLimit: 6000,
          } satisfies SimulationStatus,
        };
      if (url.pathname === '/api/audit')
        return {
          records: await this.store.audit(
            Number(url.searchParams.get('after') ?? 0),
            Number(url.searchParams.get('limit') ?? 100),
          ),
          nextAfter:
            (
              await this.store.audit(
                Number(url.searchParams.get('after') ?? 0),
                Number(url.searchParams.get('limit') ?? 100),
              )
            ).at(-1)?.sequence ?? Number(url.searchParams.get('after') ?? 0),
        };
      if (url.pathname === '/api/command') {
        const result = await this.controller.execute(
          data,
          this.actor(),
          randomUUID(),
          randomUUID(),
        );
        this.event(`${this.actor().name} recorded an operator request.`, 'review');
        return result;
      }
      if (url.pathname === '/simulation/control') {
        const input = data as { action?: string; reviewer?: 'a' | 'b'; scenario?: Scenario };
        if (input.action === 'pause') this.running = false;
        else if (input.action === 'resume') this.running = true;
        else if (input.action === 'step') await this.advance();
        else if (input.action === 'reviewer' && ['a', 'b'].includes(input.reviewer ?? '')) {
          this.reviewer = input.reviewer!;
          this.event(
            `Switched to simulated reviewer ${this.reviewer.toUpperCase()}. This is not an authenticated production identity.`,
            'review',
          );
        } else if (
          input.action === 'scenario' &&
          ['normal', 'equipment', 'temperature', 'inspection', 'interlock'].includes(
            input.scenario ?? '',
          )
        ) {
          this.scenario = input.scenario!;
          this.automaticCycle = false;
          this.lineHeld = false;
          this.cooled = false;
          this.quarantined = false;
          if (this.scenario === 'inspection') this.newInspection(true);
          this.event(`Scenario applied: ${this.scenario}.`, 'safety');
          await this.emitObservations();
          await this.controller.processOutbox();
        } else if (input.action === 'reset') {
          await this.controller.close();
          this.started = false;
          this.elapsed = 0;
          this.events = [];
          this.eventId = 0;
          this.observations.clear();
          this.positions.clear();
          this.running = true;
          this.reviewer = 'a';
          this.scenario = 'normal';
          this.lineHeld = false;
          this.cooled = false;
          this.quarantined = false;
          this.automaticCycle = true;
          this.nextAutoTransfer = 12;
          this.nextInspection = 8;
          await this.initialize();
        } else throw new HttpError(400, 'Unknown simulation control.');
        return { ok: true };
      }
      throw new HttpError(404, 'Unknown simulation operation.');
    });
  }
  async evidenceDigest(): Promise<string> {
    return digest((await this.store.read()).operations);
  }
}
