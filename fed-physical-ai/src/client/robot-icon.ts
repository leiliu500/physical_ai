import type { Reading } from '../core/types.js';

export type RobotVisualState =
  'moving' | 'idle' | 'charging' | 'fault' | 'stopped' | 'offline' | 'unknown';

export function robotVisualState(reading?: Reading, availability = 'online'): RobotVisualState {
  if (!reading || reading.kind !== 'robot') return 'unknown';
  if (availability !== 'online') return 'offline';
  if (reading.safetyStop || !reading.interlockReady) return 'stopped';
  return reading.status;
}

const indicators: Record<RobotVisualState, string> = {
  moving: '<path d="m28 36 4-4 4 4m-8-6 4-4 4 4"/>',
  idle: '<path d="M29 28v9m6-9v9"/>',
  charging: '<path d="m34 25-7 9h5l-2 7 8-11h-5z"/>',
  fault: '<path d="m32 25 9 15H23zM32 30v4m0 3v.5"/>',
  stopped: '<path d="m28 25-5 5v7l5 5h8l5-5v-7l-5-5zM28 33.5h8"/>',
  offline: '<path d="M25 26l14 14m-12-3 10-10"/>',
  unknown: '<path d="M28 29a4 4 0 1 1 6 3.5c-2 1-2 1.5-2 3M32 39v.5"/>',
};

// Inline vectors share geometry in the map, fleet cards and device tables.
// No IDs, remote assets or SVG filters: safe to repeat and crisp at small sizes.
export function robotArtwork(state: RobotVisualState): string {
  return `<g class="amr-icon amr--${state}" stroke-linecap="round" stroke-linejoin="round">
    <ellipse cx="32" cy="57" rx="20" ry="3" class="amr-shadow"/>
    <g class="amr-wheel"><rect x="9" y="21" width="8" height="23" rx="3"/><rect x="47" y="21" width="8" height="23" rx="3"/></g>
    <path d="M12 26h2m-2 6h2m-2 6h2m36-12h2m-2 6h2m-2 6h2" class="amr-tread"/>
    <rect x="15" y="8" width="34" height="49" rx="10" class="amr-chassis"/>
    <path d="M19 18v-1a5 5 0 0 1 5-5h16a5 5 0 0 1 5 5v1" class="amr-bumper"/>
    <rect x="24" y="7" width="16" height="8" rx="4" class="amr-sensor"/>
    <path d="M28 10.5h8" class="amr-lidar"/>
    <rect x="20" y="23" width="24" height="23" rx="4" class="amr-deck"/>
    <path d="M23 26v16m18-16v16" class="amr-deck-rail"/>
    <g class="amr-indicator">${indicators[state]}</g>
    <path d="M22 51h20" class="amr-status-strip"/>
    <path d="M20 20h3m18 0h3" class="amr-headlight"/>
    <circle cx="21" cy="48" r="1" class="amr-fastener"/><circle cx="43" cy="48" r="1" class="amr-fastener"/>
  </g>`;
}

export function mobileRobotIcon(state: RobotVisualState): string {
  return `<svg class="mobile-robot-icon" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true" focusable="false">${robotArtwork(state)}</svg>`;
}
