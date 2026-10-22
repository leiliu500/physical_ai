import { test, expect, type Page } from '@playwright/test';
import { emptyOperations } from '../src/core/types.js';

async function authenticated(page: Page, populated = false): Promise<void> {
  const state = emptyOperations('facility-test');
  if (populated) {
    state.commands.push({
      id: 'e98c8846-c4a3-4b7a-88fc-66257228c304',
      deviceId: 'robot',
      action: 'transfer',
      status: 'accepted',
      parameters: { destination: 'secure-receiving' },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      createdBy: 'operator',
      approvals: [],
    });
    state.devices.robot = {
      sequence: 1,
      observedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      reading: {
        kind: 'robot',
        status: 'idle',
        battery: 80,
        position: { x: 2, y: 3, frame: 'facility-map' },
        safetyStop: false,
        interlockReady: true,
      },
      history: [],
    };
  }
  const platform = {
    version: '2.0.0',
    facilityId: 'facility-test',
    ready: true,
    revision: 1,
    authentication: 'oidc',
    persistence: 'postgres',
    dispatchInhibited: true,
    inhibitReason: state.inhibitReason,
    audit: { sequence: 1, head: '0'.repeat(64) },
    devices: populated
      ? [
          {
            id: 'robot',
            kind: 'robot',
            required: true,
            capabilities: ['transfer'],
            destinations: ['secure-receiving'],
            executionConfigured: true,
            status: 'online',
            observedAt: new Date().toISOString(),
          },
        ]
      : [],
    models: [],
    policy: {},
    policyDigest: 'a'.repeat(64),
    lastFailure: null,
  };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const value: Record<string, unknown> = {
      '/api/config': { authentication: 'oidc' },
      '/api/session': {
        subject: 'reviewer',
        name: 'Operations reviewer',
        roles: ['supervisor'],
        csrf: 'csrf-test',
      },
      '/api/state': state,
      '/api/platform': platform,
      '/api/audit': { records: [], nextAfter: 0 },
    };
    await route.fulfill({
      status: path in value ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify(value[path] ?? { error: 'Unavailable in transport test.' }),
    });
  });
}
test('organization identity is required before viewing operations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to your control plane.' })).toBeVisible();
  await expect(page.getByRole('link', { name: /organization SSO/ })).toHaveAttribute(
    'href',
    '/auth/login',
  );
  await expect(page.locator('#inhibit-button')).toBeDisabled();
});
test('unavailable service cannot activate browser execution through query parameters', async ({
  page,
}) => {
  await page.route('**/api/**', (route) => route.abort());
  await page.goto('/?mode=browser');
  await expect(page.getByRole('heading', { name: 'Control service unavailable' })).toBeVisible();
  await expect(page.locator('#inhibit-button')).toBeDisabled();
  await expect(page.getByText('Confirmed transfers', { exact: true })).toHaveCount(0);
});
test('empty operating state is explicit and responsive across every workspace', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await authenticated(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No devices registered' })).toBeVisible();
  for (const [hash, heading] of [
    ['fleet', 'Fleet operations'],
    ['health', 'Asset & facility health'],
    ['inspections', 'Inspection operations'],
    ['reviews', 'Decision workspace'],
    ['assurance', 'Platform assurance'],
    ['audit', 'Audit ledger'],
  ]) {
    await page.goto('/#' + hash);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
  }
  await page.goto('/');
  await page.screenshot({
    path: `.openai/local/operations-${testInfo.project.name}.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test('reported gateway acceptance remains visibly distinct from completed transfers', async ({
  page,
}) => {
  await authenticated(page, true);
  await page.goto('/');
  await expect(page.getByText('accepted', { exact: true })).toBeVisible();
  await expect(page.getByText('Gateway accepted; completion not yet confirmed.')).toBeVisible();
  const metric = page.locator('.metric').filter({ hasText: 'Confirmed transfers' });
  await expect(metric.locator('strong')).toHaveText('0');
  await page.goto('/#fleet');
  await expect(page.getByRole('button', { name: /Request transfer/ })).toBeDisabled();
});
