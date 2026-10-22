import type { DeviceCommand, OperationsState, Proposal, Reading } from '../core/types.js';
import type { SimulationRuntime, SimulationStatus } from '../simulation/runtime.js';
import type { AdviceResult, AdvisorContext } from '../ai/contracts.js';
import { mobileRobotIcon, robotArtwork, robotVisualState } from './robot-icon.js';
interface DeviceStatus {
  id: string;
  kind: string;
  required: boolean;
  capabilities: string[];
  destinations: string[];
  executionConfigured: boolean;
  status: string;
  observedAt: string | null;
}
interface PlatformStatus {
  version: string;
  facilityId: string;
  ready: boolean;
  revision: number;
  authentication: string;
  persistence: string;
  dispatchInhibited: boolean;
  inhibitReason: string;
  audit: { sequence: number; head: string };
  devices: DeviceStatus[];
  models: {
    id: string;
    version: string;
    artifactSha256: string;
    validationReference: string;
    approved: boolean;
  }[];
  policy: Record<string, number>;
  policyDigest: string;
  lastFailure: string | null;
  simulation?: SimulationStatus;
}
interface Session {
  subject: string;
  name: string;
  roles: string[];
  csrf: string | null;
}
interface AuditRecord {
  sequence: number;
  timestamp: string;
  actor: string;
  action: string;
  requestId: string;
  details: Record<string, unknown>;
  previousHash: string;
  hash: string;
}
type View =
  'overview' | 'fleet' | 'health' | 'inspections' | 'reviews' | 'assistant' | 'assurance' | 'audit';
type Connection = 'connecting' | 'ready' | 'signin' | 'unavailable';
const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error('Missing application element.');
  return node;
};
const escape = (value: unknown): string =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const when = (value: string | null | undefined): string =>
  value ? new Date(value).toLocaleString() : 'Not observed';
const badge = (value: string, kind = ''): string =>
  `<span class="badge ${kind}">${escape(value)}</span>`;
const empty = (title: string, detail: string): string =>
  `<div class="empty-state"><span class="empty-mark" aria-hidden="true">⌁</span><h3>${escape(title)}</h3><p>${escape(detail)}</p></div>`;
const labels: Record<View, [string, string]> = {
  overview: [
    'Operations overview',
    'Authenticated observations, device readiness and execution outcomes.',
  ],
  fleet: [
    'Fleet operations',
    'Registered robots, reported safety interlocks and authorized transfers.',
  ],
  health: [
    'Asset & facility health',
    'Live equipment and environmental readings against your approved policy.',
  ],
  inspections: [
    'Inspection operations',
    'Inspection results with verified model provenance and traceable exceptions.',
  ],
  reviews: ['Decision workspace', 'Review current evidence before authorizing physical execution.'],
  assistant: [
    'AI operations assistant',
    'Bedrock reasoning over an operational snapshot, with human review before execution.',
  ],
  assurance: [
    'Platform assurance',
    'Identity, persistence, execution boundaries and approved component lineage.',
  ],
  audit: ['Audit ledger', 'Durable, ordered records linked by SHA-256 integrity hashes.'],
};
let connection: Connection = 'connecting',
  session: Session | null = null,
  state: OperationsState | null = null,
  platform: PlatformStatus | null = null,
  view: View = 'overview',
  busy = false,
  polling = false,
  csrf = '',
  auditAfter = 0;
let auditRecords: AuditRecord[] = [];
let readGeneration = 0;
let toastTimer: ReturnType<typeof setTimeout>;
const simulationPage = document.body.dataset.runtime === 'simulation';
let simulator: SimulationRuntime | undefined;
let aiStatus: { enabled: boolean; modelId: string; region: string } | null = null;
let aiAdvice: AdviceResult | null = null,
  aiBusy = false,
  aiError = '',
  aiPrompt = 'Summarize operational risks and recommend the next safe steps.';
class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function permitted(command: string): boolean {
  if (connection !== 'ready' || !session || busy) return false;
  const roles = ['review', 'release-inhibit'].includes(command)
    ? ['supervisor', 'admin']
    : ['operator', 'supervisor', 'admin'];
  return session.roles.some((role) => roles.includes(role));
}
function button(label: string, action: string, id = '', disabled = false): string {
  return `<button class="button" data-action="${escape(action)}" data-id="${escape(id)}" ${disabled ? 'disabled' : ''}>${label}</button>`;
}
function notify(message: string, error = false): void {
  const node = $('#notification');
  clearTimeout(toastTimer);
  node.textContent = message;
  node.className = error ? 'notification error' : 'notification';
  node.hidden = false;
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 5000);
}
async function request(path: string, data?: unknown): Promise<unknown> {
  if (simulationPage && !simulator)
    throw new ApiError(
      503,
      'Simulation assets are not available. Reload the simulation deployment.',
    );
  if (simulator) {
    try {
      return await simulator.request(path, data);
    } catch (error) {
      const value = error as { status?: number; message?: string };
      throw new ApiError(value.status ?? 503, value.message ?? 'Simulation operation failed.');
    }
  }
  const response = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(7000),
    ...(data === undefined
      ? {}
      : {
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
            ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          },
          body: JSON.stringify(data),
        }),
  });
  if (!response.ok) {
    const value = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(
      response.status,
      value.error ?? `Service request failed (${response.status}).`,
    );
  }
  return response.status === 204 ? null : response.json();
}
function heading(): string {
  const [title, subtitle] = labels[view];
  return `<div class="page-heading"><div><p class="eyebrow">PHYSICAL OPERATIONS / ${escape(view.toUpperCase())}</p><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${button('↻ Refresh', 'refresh')}${button('↓ Export state', 'export', '', !state)}</div></div>`;
}
function readingSummary(r: Reading): string {
  if (r.kind === 'robot') return `${r.status} · ${r.battery.toFixed(0)}% battery`;
  if (r.kind === 'processing-line')
    return `${r.vibration.toFixed(2)} mm/s · ${r.temperature.toFixed(1)} °C`;
  if (r.kind === 'environment')
    return `${r.temperature.toFixed(1)} °C · ${r.humidity.toFixed(0)}% RH`;
  return `${r.observedCount} observed / ${r.expectedCount} expected`;
}
function deviceTable(kind?: string): string {
  const devices = platform!.devices.filter((d) => !kind || d.kind === kind);
  if (!devices.length)
    return empty(
      'No devices registered',
      'Provision device identities and approved integration endpoints to begin receiving operational data.',
    );
  return `<div class="table-scroll"><table><thead><tr><th>DEVICE / CLASS</th><th>OBSERVATION</th><th>STATUS</th><th>LAST OBSERVED</th></tr></thead><tbody>${devices
    .map((d) => {
      const r = state!.devices[d.id];
      const identity = `<div><strong>${escape(d.id)}</strong><small>${escape(d.kind)}</small></div>`;
      return `<tr><td>${d.kind === 'robot' ? `<div class="device-identity"><span class="robot-table-icon">${mobileRobotIcon(robotVisualState(r?.reading, d.status))}</span>${identity}</div>` : identity}</td><td>${r ? escape(readingSummary(r.reading)) : '—'}</td><td>${badge(d.status, d.status === 'online' ? 'good' : 'warning')}</td><td class="muted">${escape(when(d.observedAt))}</td></tr>`;
    })
    .join('')}</tbody></table></div>`;
}
function commandTable(commands: DeviceCommand[]): string {
  if (!commands.length)
    return empty(
      'No execution requests',
      'Commands appear after an authorized operator request or an approved equipment response.',
    );
  return `<div class="table-scroll"><table><thead><tr><th>ACTION / DEVICE</th><th>EXECUTION STATE</th><th>CREATED</th><th>GATEWAY EVIDENCE</th></tr></thead><tbody>${commands
    .slice()
    .reverse()
    .map(
      (c) =>
        `<tr><td><strong>${escape(c.action)}</strong><small>${escape(c.deviceId)}</small><code>${escape(c.id.slice(0, 8))}</code></td><td>${badge(c.status, c.status === 'succeeded' ? 'good' : ['uncertain', 'failed', 'rejected'].includes(c.status) ? 'critical' : 'neutral')}</td><td class="muted">${escape(when(c.createdAt))}</td><td class="muted">${escape(c.detail ?? (c.status === 'accepted' ? 'Gateway accepted; completion not yet confirmed.' : c.acknowledgedAt ? when(c.acknowledgedAt) : 'Awaiting signed acknowledgement.'))}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}
function stats(): string {
  const online = platform!.devices.filter((d) => d.status === 'online').length,
    pending = state!.proposals.filter((p) => p.status === 'pending').length;
  return `<div class="metrics">${[
    ['Connected devices', online, `${platform!.devices.length} registered identities`],
    [
      'Confirmed transfers',
      state!.metrics.completedTransfers,
      'Completed by signed acknowledgement',
    ],
    ['Review queue', pending, 'Current equipment and inspection exceptions'],
    [
      'Confirmed commands',
      state!.metrics.confirmedCommands,
      'Physical outcomes reported by gateways',
    ],
  ]
    .map(
      ([name, value, detail]) =>
        `<article class="metric"><span>${name}</span><strong>${value}</strong><small>${detail}</small></article>`,
    )
    .join('')}</div>`;
}
function panel(title: string, body: string, detail = ''): string {
  return `<section class="panel"><div class="panel-heading"><div><h2>${title}</h2>${detail ? `<p>${detail}</p>` : ''}</div></div>${body}</section>`;
}
function overview(): string {
  return `${stats()}${simulationPage ? simulationActivity() : ''}<div class="content-grid">${panel('Connected operations', deviceTable(), 'Values come from signed device observations.')}${panel('Execution boundary', `<div class="panel-body"><div class="control-state">${badge(state!.dispatchInhibited ? 'Dispatch inhibited' : 'Dispatch released', state!.dispatchInhibited ? 'warning' : 'good')}</div><h3>${state!.dispatchInhibited ? 'New physical commands are held.' : 'Authorized commands may be transmitted.'}</h3><p>${escape(state!.inhibitReason || 'Each command is rechecked against device freshness, capabilities and reported robot interlocks before transmission.')}</p>${button('Review release conditions', 'release', '', !permitted('release-inhibit') || !state!.dispatchInhibited)}<div class="note">Inhibiting dispatch prevents new transmissions. Physical emergency stops and safety controllers remain device-local.</div></div>`)}</div>${panel('Execution ledger', commandTable(state!.commands.slice(-12)))}<div class="section-heading"><h2>Attention required</h2><a href="#reviews">Open decision workspace ↗</a></div>${reviewCards(state!.proposals.filter((p) => p.status === 'pending').slice(0, 3))}`;
}
function simulationActivity(): string {
  const sim = platform?.simulation;
  if (!sim) return '';
  const robots = Object.entries(state!.devices).filter(
    ([, device]) => device.reading.kind === 'robot',
  );
  const map = `<div class="facility-map"><svg viewBox="0 0 680 380" role="img" aria-label="Simulated facility with moving mobile robots"><defs><pattern id="map-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#e6ece8" stroke-width="0.6"/></pattern></defs><rect width="680" height="380" fill="url(#map-grid)"/>${[128, 208, 288].map((y) => `<path d="M90 ${y}H590" class="map-route"/>`).join('')}${[
    [20, 'RECEIVING', 'Dock and intake'],
    [270, 'CASH PROCESSING', 'Sorting and inspection'],
    [520, 'SECURE STORAGE', 'Controlled access'],
  ]
    .map(
      ([x, title, detail]) =>
        `<rect x="${x}" y="20" width="140" height="66" rx="8" class="map-zone"/><text x="${Number(x) + 70}" y="47" text-anchor="middle" class="map-title">${title}</text><text x="${Number(x) + 70}" y="66" text-anchor="middle" class="map-detail">${detail}</text><path d="M${Number(x) + 70} 86V288" class="map-connector"/>`,
    )
    .join('')}${robots
    .map(([id, device], i) => {
      const r = device.reading;
      if (r.kind !== 'robot') return '';
      const y = r.position.y + 68 + (i - 1) * 80;
      const visual = robotVisualState(r);
      return `<g transform="translate(${r.position.x} ${y})" class="map-robot ${visual === 'stopped' ? 'stopped' : ''}" role="img" aria-label="${escape(id)}: ${visual}"><title>${escape(id)} · ${visual} · ${r.battery.toFixed(0)}% battery</title><g transform="translate(-28 -28) scale(.875)">${robotArtwork(visual)}</g><rect x="-31" y="29" width="62" height="19" rx="5" class="map-unit-plate"/><text text-anchor="middle" y="42" class="map-unit-label">${escape(id.replace(/^SIM-/, ''))}</text></g>`;
    })
    .join(
      '',
    )}<text x="20" y="370" class="map-detail">SYNTHETIC COORDINATES · SIMULATION ONLY</text></svg><div class="map-legend" aria-label="Mobile robot status">${robots
    .map(([id, d]) => {
      const visual = robotVisualState(d.reading);
      return `<span class="robot-key"><span class="robot-key-icon">${mobileRobotIcon(visual)}</span><strong>${escape(id)}</strong>${badge(visual, ['stopped', 'fault'].includes(visual) ? 'critical' : 'neutral')}</span>`;
    })
    .join('')}</div></div>`;
  const events = `<ol class="activity-feed" aria-label="Simulation activity">${sim.events
    .slice(0, 7)
    .map(
      (e) =>
        `<li><span class="activity-dot ${e.category}"></span><div><p>${escape(e.message)}</p><time>${escape(when(e.timestamp))}</time></div></li>`,
    )
    .join('')}</ol>`;
  return `<div class="simulation-grid">${panel('Facility digital twin', map, `Simulation elapsed ${sim.elapsedSeconds}s · ${state!.metrics.acceptedObservations} generated observations`)}${panel('Activity stream', events, 'Generated events from this browser session')}</div>`;
}
function renderSimulationControls(): void {
  const sim = platform?.simulation;
  if (!simulationPage || !sim) return;
  const toggle = $<HTMLButtonElement>('#sim-toggle');
  toggle.textContent = sim.running ? 'Pause' : 'Resume';
  toggle.dataset.action = sim.running ? 'sim-pause' : 'sim-resume';
  $('#sim-clock').textContent = `t+${sim.elapsedSeconds}s · ${sim.running ? 'Running' : 'Paused'}`;
  const reviewer = $<HTMLSelectElement>('#sim-reviewer'),
    scenario = $<HTMLSelectElement>('#sim-scenario');
  if (document.activeElement !== reviewer) reviewer.value = sim.reviewer;
  if (document.activeElement !== scenario) scenario.value = sim.scenario;
}
async function simulationControl(data: Record<string, unknown>): Promise<void> {
  if (!simulator || busy) return;
  busy = true;
  readGeneration++;
  try {
    await request('/simulation/control', data);
    if (data.action === 'reset') {
      auditRecords = [];
      auditAfter = 0;
      aiAdvice = null;
    }
    session = (await request('/api/session')) as Session;
    await refresh();
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Simulation control failed.', true);
  } finally {
    busy = false;
    render();
  }
}
function fleet(): string {
  const robots = platform!.devices.filter((d) => d.kind === 'robot');
  return `${panel(
    'Registered mobile robots',
    robots.length
      ? `<div class="robot-list">${robots
          .map((d) => {
            const record = state!.devices[d.id],
              r = record?.reading;
            if (!r || r.kind !== 'robot')
              return `<article class="robot-card"><div class="robot-title"><span class="robot-avatar">${mobileRobotIcon('unknown')}</span><h3>${escape(d.id)}</h3>${badge(d.status, 'warning')}</div><p>No authenticated robot observation has been received.</p></article>`;
            const safe =
              d.status === 'online' && !r.safetyStop && r.interlockReady && r.status === 'idle';
            return `<article class="robot-card"><div class="robot-title"><span class="robot-avatar">${mobileRobotIcon(robotVisualState(r, d.status))}</span><div class="robot-identity"><h3>${escape(d.id)}</h3><p>${escape(r.position.frame)} · (${r.position.x}, ${r.position.y})</p></div>${badge(d.status, d.status === 'online' ? 'good' : 'warning')}</div><dl><div><dt>Reported state</dt><dd>${escape(r.status)}</dd></div><div><dt>Battery</dt><dd>${r.battery.toFixed(0)}%</dd></div><div><dt>Hardware stop</dt><dd>${r.safetyStop ? 'Engaged' : 'Clear'}</dd></div><div><dt>Interlock</dt><dd>${r.interlockReady ? 'Ready' : 'Not ready'}</dd></div></dl>${button('Request transfer ↗', 'transfer', d.id, !safe || !d.executionConfigured || !permitted('transfer') || state!.dispatchInhibited)}</article>`;
          })
          .join('')}</div>`
      : empty(
          'No robots registered',
          'Connect your fleet gateways and configure their authorized destinations.',
        ),
  )}${panel('Transfer ledger', commandTable(state!.commands.filter((c) => c.action === 'transfer')))}`;
}
function chart(id: string, field: 'vibration' | 'temperature'): string {
  const points = (state!.devices[id]?.history ?? []).flatMap((p) =>
    field in p.reading
      ? [{ time: p.timestamp, value: Number(p.reading[field as keyof typeof p.reading]) }]
      : [],
  );
  if (points.length < 2)
    return '<p class="chart-empty">Waiting for additional observations to show a trend.</p>';
  const min = Math.min(...points.map((p) => p.value)),
    max = Math.max(...points.map((p) => p.value)),
    range = max - min || 1;
  return `<svg viewBox="0 0 600 110" class="trend" role="img" aria-label="Observed ${field} trend"><path d="M0 100H600M0 55H600M0 10H600" fill="none" stroke="#e6ece6"/><polyline points="${points.map((p, i) => `${(i * 600) / (points.length - 1)},${100 - ((p.value - min) / range) * 90}`).join(' ')}" fill="none" stroke="#20796c" stroke-width="2"/></svg><div class="chart-range"><span>${escape(when(points[0].time))}</span><span>${escape(when(points.at(-1)!.time))}</span></div>`;
}
function health(): string {
  const devices = platform!.devices.filter((d) =>
    ['processing-line', 'environment'].includes(d.kind),
  );
  if (!devices.length)
    return panel(
      'Asset monitoring',
      empty(
        'No monitoring sources registered',
        'Register processing-line and environmental sensors with their approved operating policy.',
      ),
    );
  return `<div class="sensor-grid">${devices
    .map((d) => {
      const record = state!.devices[d.id],
        r = record?.reading;
      return panel(
        escape(d.id),
        r && ['processing-line', 'environment'].includes(r.kind)
          ? `<div class="panel-body">${badge(d.status, d.status === 'online' ? 'good' : 'warning')}<p class="sensor-value">${escape(readingSummary(r))}</p>${chart(d.id, r.kind === 'processing-line' ? 'vibration' : 'temperature')}<p class="muted">Last accepted: ${escape(when(record.observedAt))}</p></div>`
          : empty(
              'Awaiting device observations',
              'No readings are inferred while a source is disconnected.',
            ),
        escape(d.kind),
      );
    })
    .join(
      '',
    )}</div>${panel('Recommended responses', reviewCards(state!.proposals.filter((p) => p.status === 'pending' && p.action !== 'quarantine')))}`;
}
function inspections(): string {
  const devices = platform!.devices.filter((d) => d.kind === 'inspection');
  return `<div class="metrics compact"><article class="metric"><span>Unique inspections</span><strong>${state!.metrics.inspections}</strong><small>Accepted, signed inspection identifiers</small></article><article class="metric"><span>Approved models</span><strong>${platform!.models.filter((m) => m.approved).length}</strong><small>Configured artifact and validation references</small></article></div>${panel(
    'Inspection stations',
    devices.length
      ? `<div class="table-scroll"><table><thead><tr><th>STATION / BUNDLE</th><th>OBSERVED / EXPECTED</th><th>CONFIDENCE</th><th>MODEL PROVENANCE</th></tr></thead><tbody>${devices
          .map((d) => {
            const r = state!.devices[d.id]?.reading;
            return r?.kind === 'inspection'
              ? `<tr><td><strong>${escape(d.id)}</strong><small>${escape(r.bundleId)}</small></td><td>${r.observedCount} / ${r.expectedCount}</td><td>${(r.confidence * 100).toFixed(1)}%</td><td><strong>${escape(r.modelId)} · ${escape(r.modelVersion)}</strong><code class="hash">${escape(r.artifactSha256)}</code></td></tr>`
              : `<tr><td>${escape(d.id)}</td><td colspan="3">Awaiting an authenticated inspection result.</td></tr>`;
          })
          .join('')}</tbody></table></div>`
      : empty(
          'No inspection stations registered',
          'Configure an approved model artifact and its authenticated inspection source.',
        ),
  )}${panel('Inspection exception reviews', reviewCards(state!.proposals.filter((p) => p.status === 'pending' && p.action === 'quarantine')))}`;
}
function reviewCards(proposals: Proposal[]): string {
  if (!proposals.length)
    return empty(
      'No pending reviews',
      'New reviews are created from accepted observations that cross the configured policy.',
    );
  return `<div class="reviews-grid">${proposals
    .map((p) => {
      const endpoint = platform!.devices.find((d) => d.id === p.deviceId)?.executionConfigured;
      return `<article class="review-card">${badge(p.action === 'quarantine' ? 'Two-person authorization' : 'Supervisor authorization', 'neutral')}<h3>${escape(p.title)}</h3><p>${escape(p.deviceId)} · ${escape(readingSummary(p.reading))}</p><dl><div><dt>Approvals</dt><dd>${p.approvals.length}/${p.requiredApprovals}</dd></div><div><dt>Evidence revision</dt><dd>${p.revision}</dd></div></dl><p class="muted">Updated ${escape(when(p.updatedAt))}</p>${!endpoint ? '<div class="note">Execution is unavailable until an authorized gateway is configured.</div>' : ''}<div class="review-actions">${button(p.approvals.includes(session!.subject) ? 'Approval recorded' : 'Approve', 'approve', p.id, !permitted('review') || p.approvals.includes(session!.subject) || !endpoint || state!.dispatchInhibited)}${button('Reject', 'reject', p.id, !permitted('review'))}${button('Refresh evidence', 'refresh-review', p.id, !permitted('review'))}</div></article>`;
    })
    .join('')}</div>`;
}
function reviews(): string {
  return `${reviewCards(state!.proposals.filter((p) => p.status === 'pending'))}${panel('Authorized execution requests', commandTable(state!.commands.filter((c) => Boolean(c.proposalId))))}`;
}
function assistant(): string {
  const advice = aiAdvice;
  return `<div class="assurance-banner"><p class="eyebrow">AMAZON BEDROCK · PLANNING</p><h2>Reason about operations.</h2><p>Model: <code>${escape(aiStatus?.modelId ?? 'openai.gpt-oss-120b-1:0')}</code> · ${escape(aiStatus?.region ?? 'us-gov-west-1')}</p></div>${panel('Ask the operations assistant', `<div class="panel-body"><p class="note">${simulationPage ? 'Only the synthetic facility snapshot is sent to the server-side Bedrock bridge.' : 'The server selects the registered device readings and pending reviews to send to Bedrock.'} Recommendations require explicit operator action and the existing controller checks.</p>${!aiStatus?.enabled ? '<div class="ai-status">Bedrock is not enabled on this server. For localhost, start <code>npm run simulation:bedrock</code> with a valid AWS profile. The static hosted simulator has no Bedrock backend.</div>' : ''}<form id="ai-form"><label for="ai-prompt">Operational request</label><textarea id="ai-prompt" name="prompt" minlength="5" maxlength="2000" rows="4" required>${escape(aiPrompt)}</textarea><button class="button primary" type="submit" ${aiBusy || !aiStatus?.enabled || !permitted('transfer') ? 'disabled' : ''}>${aiBusy ? 'Requesting Bedrock advice…' : 'Generate recommendations'}</button></form>${aiError ? `<p class="ai-error" role="alert">${escape(aiError)}</p>` : ''}</div>`)}${advice ? panel('Model recommendation', `<div class="panel-body ai-result"><div>${badge(advice.source === 'simulation' ? 'Synthetic context' : 'Production snapshot', 'warning')}<span class="muted"> ${escape(when(advice.createdAt))}</span></div><h3>${escape(advice.summary)}</h3><ul>${advice.observations.map((value) => `<li>${escape(value)}</li>`).join('')}</ul><div class="ai-recommendations">${advice.recommendations.map((recommendation, index) => `<article><h3>${escape(recommendation.kind === 'transfer' ? `${recommendation.deviceId} → ${recommendation.destination}` : recommendation.kind === 'review' ? 'Open the pending evidence review' : 'Prepare a dispatch hold')}</h3><p>${escape(recommendation.rationale)}</p>${button(recommendation.kind === 'transfer' ? 'Prepare transfer for review' : recommendation.kind === 'review' ? 'Open decision workspace' : 'Review dispatch hold', 'ai-prepare', String(index), !permitted('transfer'))}</article>`).join('')}</div>${advice.limitations.length ? `<h3>Limits and missing information</h3><ul>${advice.limitations.map((value) => `<li>${escape(value)}</li>`).join('')}</ul>` : ''}<p class="muted">${advice.usage.inputTokens} input / ${advice.usage.outputTokens} output tokens · Context SHA-256</p><code class="hash">${escape(advice.contextDigest)}</code><p class="muted">No command was dispatched by this model response.</p></div>`) : ''}`;
}
async function aiFetch(path: string, data?: unknown): Promise<unknown> {
  const response = await fetch(`${simulationPage ? '/simulation/ai' : '/api/ai'}/${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(65000),
    ...(data === undefined
      ? {}
      : {
          headers: {
            'Content-Type': 'application/json',
            ...(simulationPage
              ? { 'X-Simulation-Request': '1' }
              : csrf
                ? { 'X-CSRF-Token': csrf }
                : {}),
          },
          body: JSON.stringify(data),
        }),
  });
  const result = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok)
    throw new Error(
      result.error ?? 'The Bedrock planning service is unavailable on this deployment.',
    );
  return result;
}
async function loadAiStatus(): Promise<void> {
  try {
    aiStatus = (await aiFetch('status')) as typeof aiStatus;
  } catch {
    aiStatus = { enabled: false, modelId: 'openai.gpt-oss-120b-1:0', region: 'us-gov-west-1' };
  }
  if (view === 'assistant') render();
}
async function askAi(): Promise<void> {
  if (aiBusy || !state || !platform) return;
  aiBusy = true;
  aiAdvice = null;
  aiError = '';
  render();
  try {
    const context: AdvisorContext = {
      source: 'simulation',
      facilityId: state.facilityId,
      dispatchInhibited: state.dispatchInhibited,
      devices: platform.devices.slice(0, 40).map((device) => ({
        id: device.id,
        kind: device.kind as AdvisorContext['devices'][number]['kind'],
        observedAt: state!.devices[device.id]?.observedAt ?? null,
        reading: state!.devices[device.id]?.reading ?? null,
        destinations: device.destinations.slice(0, 50),
        capabilities: device.capabilities,
      })),
      reviews: state.proposals
        .filter((proposal) => proposal.status === 'pending')
        .slice(0, 40)
        .map((proposal) => ({
          id: proposal.id,
          deviceId: proposal.deviceId,
          action: proposal.action,
          title: proposal.title,
          approvals: proposal.approvals.length,
          requiredApprovals: proposal.requiredApprovals,
        })),
    };
    aiAdvice = (await aiFetch(
      'plan',
      simulationPage ? { prompt: aiPrompt, context } : { prompt: aiPrompt },
    )) as AdviceResult;
  } catch (error) {
    aiError = error instanceof Error ? error.message : 'Bedrock planning failed.';
  } finally {
    aiBusy = false;
    render();
  }
}
function assurance(): string {
  if (simulationPage)
    return `${panel('Simulation assurance', '<div class="panel-body"><h2>Isolated browser session</h2><p>Device readings, reviewer identities, model lineage and gateway outcomes are generated in memory. This environment exercises the same controller policy, quorum, replay protection and acknowledgement state transitions as the production service.</p><div class="note">No organization OIDC, PostgreSQL persistence, qualified inference model or physical equipment is connected to this simulation. Reloading starts a new run.</div></div>')}${panel('Active simulation controls', `<div class="table-scroll"><table><tbody><tr><th>Identity</th><td>Two explicitly simulated reviewer identities</td></tr><tr><th>Persistence</th><td>Browser session memory · no durable retention</td></tr><tr><th>Device protocol</th><td>Synthetic HMAC-signed envelopes through the shared controller</td></tr><tr><th>Gateway</th><td>In-memory acceptance and completion · no network actuation</td></tr><tr><th>Scenario</th><td>${escape(platform?.simulation?.scenario)}</td></tr><tr><th>Audit records</th><td>${platform!.audit.sequence} linked records in this run</td></tr><tr><th>Fixture model</th><td>SIM-vision · synthetic-1 · no physical inference</td></tr></tbody></table></div>`)}`;
  return `<div class="assurance-banner"><p class="eyebrow">OPERATIONAL CONTROL PLANE</p><h2>Verified identity. Traceable decisions.</h2><p>Readiness reflects the configured service and actual device observations.</p></div><div class="content-grid">${panel('Active service controls', `<div class="table-scroll"><table><tbody><tr><th>Identity</th><td>OIDC · Signed JWT access tokens</td></tr><tr><th>Persistence</th><td>PostgreSQL transactional state and audit</td></tr><tr><th>Device ingress</th><td>HMAC signatures · Bounded freshness · Durable sequences</td></tr><tr><th>Execution</th><td>${platform!.devices.filter((d) => d.executionConfigured).length} configured HTTPS gateways</td></tr><tr><th>Release state</th><td>${badge(state!.dispatchInhibited ? 'Inhibited' : 'Released', state!.dispatchInhibited ? 'warning' : 'good')}</td></tr><tr><th>Durable revision</th><td>${platform!.revision}</td></tr></tbody></table></div>`)}${panel(
    'Approved safety policy',
    `<div class="table-scroll"><table><tbody>${Object.entries(platform!.policy)
      .map(([key, value]) => `<tr><th>${escape(key)}</th><td>${escape(value)}</td></tr>`)
      .join('')}</tbody></table></div>`,
  )}</div>${panel('Model registry', platform!.models.length ? `<div class="table-scroll"><table><thead><tr><th>MODEL / VERSION</th><th>ARTIFACT SHA-256</th><th>VALIDATION</th><th>APPROVAL</th></tr></thead><tbody>${platform!.models.map((m) => `<tr><td>${escape(m.id)}<small>${escape(m.version)}</small></td><td><code class="hash">${escape(m.artifactSha256)}</code></td><td>${escape(m.validationReference)}</td><td>${badge(m.approved ? 'Approved' : 'Not approved', m.approved ? 'good' : 'warning')}</td></tr>`).join('')}</tbody></table></div>` : empty('No models registered', 'Register validated model versions and artifact digests before accepting model-derived observations.'))}${panel('Audit integrity', `<div class="panel-body"><p>${platform!.audit.sequence} durable records</p><code class="hash">${escape(platform!.audit.head)}</code><p class="muted">Independently retain chain heads according to your audit policy.</p></div>`)}`;
}
function audit(): string {
  const records = auditRecords.length
    ? `<div class="table-scroll"><table><thead><tr><th>SEQ / TIME</th><th>ACTION</th><th>ACTOR</th><th>INTEGRITY HASH</th></tr></thead><tbody>${auditRecords.map((r) => `<tr><td>${r.sequence}<small>${escape(when(r.timestamp))}</small></td><td>${escape(r.action)}</td><td>${escape(r.actor)}</td><td><code class="hash">${escape(r.hash)}</code></td></tr>`).join('')}</tbody></table></div>`
    : empty(
        'No records loaded',
        'Load records from the durable audit API to inspect their ordered chain.',
      );
  return panel(
    simulationPage ? 'Simulation audit ledger' : 'Durable audit ledger',
    `<div class="panel-toolbar">${button('Load next records', 'load-audit')}${button('Export audit chain', 'export-audit')}</div>${records}`,
  );
}
function render(): void {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null,
    action = active?.dataset.action,
    id = active?.dataset.id;
  $<HTMLButtonElement>('#inhibit-button').disabled = !permitted('inhibit');
  $('#connection-label').textContent =
    connection === 'ready'
      ? 'Control service connected'
      : connection === 'signin'
        ? 'Authentication required'
        : connection === 'connecting'
          ? 'Connecting'
          : 'Service unavailable';
  $('#facility-name').textContent = platform?.facilityId ?? 'Facility connection';
  $('#identity').textContent = session?.name ?? 'Organization access';
  $<HTMLButtonElement>('#sign-out').hidden = !session;
  if (simulationPage) $<HTMLButtonElement>('#sign-out').hidden = true;
  $('#service-mode').textContent = simulationPage
    ? 'SIMULATION · Browser session'
    : 'Production control plane · v2.0';
  if (simulationPage && connection === 'ready')
    $('#connection-label').textContent = 'Simulation active';
  renderSimulationControls();
  const notice = $('#service-notice');
  notice.hidden = connection === 'ready';
  notice.textContent = simulationPage
    ? connection === 'unavailable'
      ? 'The local simulator is unavailable. Reload this simulation deployment.'
      : 'Starting the browser-local simulation.'
    : connection === 'unavailable'
      ? 'The control service is unavailable. Commands are disabled; displayed observations may be stale.'
      : connection === 'signin'
        ? 'Sign in with your organization identity to access operations.'
        : 'Establishing an authenticated service connection.';
  document.querySelectorAll<HTMLElement>('[data-view]').forEach((node) => {
    node.classList.toggle('active', node.dataset.view === view);
    if (node.dataset.view === view) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  if (connection === 'signin') {
    $('#main').innerHTML =
      `<div class="access-card"><p class="eyebrow">SECURE OPERATIONS</p><h1>Sign in to your control plane.</h1><p>Your organization identity determines the facilities and operations you can access.</p><a class="button primary" href="/auth/login">Continue with organization SSO ↗</a></div>`;
    return;
  }
  if (!state || !platform || !session) {
    if (simulationPage) {
      $('#main').innerHTML =
        `<div class="access-card"><p class="eyebrow">SIMULATION WORKSPACE</p><h1>${connection === 'connecting' ? 'Starting simulation' : 'Simulation unavailable'}</h1><p>Generated devices and controller workflows run in this browser session. No physical control service is contacted.</p>${button('Reload simulation', 'reconnect')}</div>`;
      return;
    }
    $('#main').innerHTML =
      `<div class="access-card"><p class="eyebrow">PRODUCTION SERVICE CONNECTION</p><h1>${connection === 'connecting' ? 'Connecting to operations…' : 'Control service unavailable'}</h1><p>${connection === 'connecting' ? 'Verifying the configured API and organization session.' : 'Serve this console with the configured PostgreSQL-backed control service and organization identity provider. No device status or execution result is generated locally.'}</p>${button('Retry connection', 'reconnect')}</div>`;
    return;
  }
  if (view === 'assistant' && active?.closest('#ai-form') && !aiBusy && !aiAdvice && !aiError)
    return;
  $('#main').innerHTML =
    heading() +
    { overview, fleet, health, inspections, reviews, assistant, assurance, audit }[view]();
  if (action)
    document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((node) => {
      if (node.dataset.action === action && node.dataset.id === id)
        node.focus({ preventScroll: true });
    });
}
async function refresh(): Promise<void> {
  if (polling) return;
  const generation = readGeneration;
  polling = true;
  try {
    const [newState, newPlatform] = await Promise.all([
      request('/api/state'),
      request('/api/platform'),
    ]);
    if (generation !== readGeneration) return;
    state = newState as OperationsState;
    platform = newPlatform as PlatformStatus;
    connection = 'ready';
    render();
  } catch (e) {
    if (generation !== readGeneration) return;
    if (e instanceof ApiError && e.status === 401) {
      session = null;
      csrf = '';
      state = null;
      platform = null;
      connection = 'signin';
    } else connection = 'unavailable';
    render();
  } finally {
    polling = false;
  }
}
async function connect(): Promise<void> {
  connection = 'connecting';
  render();
  try {
    await request('/api/config');
    session = (await request('/api/session')) as Session;
    csrf = session.csrf ?? '';
    await refresh();
  } catch (e) {
    connection = e instanceof ApiError && e.status === 401 ? 'signin' : 'unavailable';
    render();
  }
}
async function send(command: string, data: Record<string, unknown>): Promise<void> {
  if (busy) return;
  busy = true;
  readGeneration++;
  render();
  try {
    state = (await request('/api/command', { command, data })) as OperationsState;
    render();
    await refresh();
    notify(
      command === 'inhibit'
        ? 'New dispatch has been inhibited.'
        : 'Request recorded. Physical completion requires a signed gateway result.',
    );
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Operation failed.', true);
    if (e instanceof ApiError && e.status === 401) {
      connection = 'signin';
      session = null;
      state = null;
      platform = null;
      render();
    }
  } finally {
    busy = false;
    render();
  }
}
function openAction(action: string, id = ''): void {
  const dialog = $<HTMLDialogElement>('#action-dialog'),
    form = $<HTMLFormElement>('#action-form');
  form.dataset.action = action;
  form.dataset.id = id;
  $('#dialog-title').textContent =
    action === 'transfer'
      ? 'Request a physical transfer'
      : action === 'release-inhibit'
        ? 'Release dispatch inhibition'
        : 'Inhibit new dispatch';
  const device = platform?.devices.find((d) => d.id === id);
  $('#dialog-fields').innerHTML =
    action === 'transfer'
      ? `<label>Robot<input value="${escape(id)}" disabled></label><label>Authorized destination<select name="destination" required>${(device?.destinations ?? []).map((d) => `<option value="${escape(d)}">${escape(d)}</option>`).join('')}</select></label><label>Transfer reference<input name="reference" required maxlength="100" autocomplete="off"></label>`
      : '<label>Operational reason<textarea name="reason" required minlength="5" maxlength="500" rows="4"></textarea></label>';
  dialog.showModal();
}
function download(name: string, data: unknown): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function loadAudit(): Promise<void> {
  try {
    const result = (await request(`/api/audit?after=${auditAfter}&limit=200`)) as {
      records: AuditRecord[];
      nextAfter: number;
    };
    auditRecords.push(...result.records);
    auditAfter = result.nextAfter;
    render();
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Audit request failed.', true);
  }
}
async function exportAudit(): Promise<void> {
  try {
    let after = 0,
      truncated = false;
    const records: AuditRecord[] = [];
    for (let i = 0; i < 10; i++) {
      const page = (await request(`/api/audit?after=${after}&limit=1000`)) as {
        records: AuditRecord[];
        nextAfter: number;
      };
      records.push(...page.records);
      after = page.nextAfter;
      if (page.records.length < 1000) break;
      if (i === 9) truncated = true;
    }
    download('reserve-audit.json', { records, truncated, nextAfter: after });
    notify(
      truncated
        ? 'First 10,000 records exported. Continue with the audit API.'
        : 'Audit chain exported.',
    );
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Audit export failed.', true);
  }
}
document.addEventListener('click', (event) => {
  // The form stores its operation in data-action; only buttons initiate click actions.
  const target =
    event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('button[data-action]')
      : null;
  if (!target || target.disabled) return;
  const action = target.dataset.action!,
    id = target.dataset.id ?? '';
  if (action === 'reconnect') {
    if (simulationPage) location.reload();
    else void connect();
  }
  if (action === 'refresh') void refresh();
  if (action === 'inhibit') openAction('inhibit');
  if (action === 'release') openAction('release-inhibit');
  if (action === 'transfer') openAction('transfer', id);
  if (action === 'ai-prepare') {
    const recommendation = aiAdvice?.recommendations[Number(id)];
    if (recommendation?.kind === 'review') location.hash = 'reviews';
    if (recommendation?.kind === 'inhibit') openAction('inhibit');
    if (recommendation?.kind === 'transfer') {
      openAction('transfer', recommendation.deviceId);
      $<HTMLSelectElement>('#action-form [name="destination"]').value = recommendation.destination;
      $<HTMLInputElement>('#action-form [name="reference"]').value =
        `AI-${aiAdvice!.id.slice(0, 8)}`;
    }
  }
  if (action === 'cancel-dialog') $<HTMLDialogElement>('#action-dialog').close();
  if (['approve', 'reject', 'refresh-review'].includes(action)) {
    const p = state?.proposals.find((p) => p.id === id);
    if (p)
      void send('review', {
        id,
        action:
          action === 'refresh-review' ? 'refresh' : action === 'approve' ? 'approve' : 'reject',
        reviewToken: p.reviewToken,
      });
  }
  if (action === 'export')
    download(simulationPage ? 'reserve-simulation.json' : 'reserve-operations.json', {
      mode: simulationPage ? 'simulation' : 'production',
      exportedAt: new Date().toISOString(),
      state,
      platform,
    });
  if (action.startsWith('sim-')) void simulationControl({ action: action.slice(4) });
  if (action === 'load-audit') void loadAudit();
  if (action === 'export-audit') void exportAudit();
  if (action === 'logout')
    void request('/auth/logout', {})
      .then(() => {
        session = null;
        state = null;
        platform = null;
        csrf = '';
        connection = 'signin';
        render();
      })
      .catch(() => notify('Sign-out could not be completed.', true));
});
$<HTMLFormElement>('#action-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = $<HTMLFormElement>('#action-form'),
    values = new FormData(form),
    action = form.dataset.action!;
  const data: Record<string, unknown> =
    action === 'transfer'
      ? {
          deviceId: form.dataset.id,
          destination: values.get('destination'),
          reference: values.get('reference'),
        }
      : { reason: values.get('reason') };
  $<HTMLDialogElement>('#action-dialog').close();
  void send(action, data);
});
function navigate(): void {
  const next = location.hash.slice(1);
  view = Object.hasOwn(labels, next) ? (next as View) : 'overview';
  render();
  if (view === 'audit' && !auditRecords.length && connection === 'ready') void loadAudit();
  if (view === 'assistant' && !aiStatus) void loadAiStatus();
}
document.addEventListener('input', (event) => {
  if (event.target instanceof HTMLTextAreaElement && event.target.id === 'ai-prompt')
    aiPrompt = event.target.value;
});
document.addEventListener('submit', (event) => {
  if (event.target instanceof HTMLFormElement && event.target.id === 'ai-form') {
    event.preventDefault();
    void askAi();
  }
});
window.addEventListener('hashchange', navigate);
navigate();
async function boot(): Promise<void> {
  if (simulationPage) {
    const section = document.createElement('section');
    section.className = 'simulation-controls';
    section.setAttribute('aria-label', 'Simulation controls');
    section.innerHTML = `<div class="simulation-caption"><strong><span class="simulation-pulse"></span>SIMULATION ENVIRONMENT</strong><span>Generated data · Local session · No physical equipment</span></div><div class="simulation-actions"><span id="sim-clock">Starting</span><button class="button" id="sim-toggle" data-action="sim-pause">Pause</button>${button('Advance 1s', 'sim-step')}${button('Reset run', 'sim-reset')}<label>Reviewer<select id="sim-reviewer"><option value="a">Simulated reviewer A</option><option value="b">Simulated reviewer B</option></select></label><label>Scenario<select id="sim-scenario"><option value="normal">Normal operation</option><option value="equipment">Equipment fault</option><option value="temperature">Temperature excursion</option><option value="inspection">Inspection exception</option><option value="interlock">Robot interlock</option></select></label></div>`;
    $('#service-notice').before(section);
    $('#sim-reviewer').addEventListener(
      'change',
      (event) =>
        void simulationControl({
          action: 'reviewer',
          reviewer: (event.target as HTMLSelectElement).value,
        }),
    );
    $('#sim-scenario').addEventListener(
      'change',
      (event) =>
        void simulationControl({
          action: 'scenario',
          scenario: (event.target as HTMLSelectElement).value,
        }),
    );
    $('.sidebar-note').innerHTML =
      '<strong>Simulation workspace</strong><p>Generated observations.<br>Simulated reviewers.<br>No physical connections.</p>';
    $('footer span').textContent =
      'SIMULATION ONLY · Session data resets when this page is reloaded.';
    try {
      const module = await import('../simulation/browser.js');
      simulator = new module.SimulationRuntime();
    } catch {
      connection = 'unavailable';
      render();
      notify('Simulation assets could not be loaded. Reload this simulation deployment.', true);
      return;
    }
    setInterval(() => {
      if (!busy)
        void simulator!
          .tick()
          .then(() => refresh())
          .catch((error) =>
            notify(error instanceof Error ? error.message : 'Simulation stopped.', true),
          );
    }, 1000);
  } else
    setInterval(() => {
      if (session && !busy) void refresh();
    }, 3000);
  await connect();
}
void boot();
