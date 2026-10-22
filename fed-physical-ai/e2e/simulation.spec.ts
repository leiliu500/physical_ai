import { test, expect } from '@playwright/test';
test.use({ baseURL: 'http://127.0.0.1:4174' });

test('simulation shows active devices, moving robots and completed transfers without an API backend', async ({
  page,
}, info) => {
  const errors: string[] = [],
    apiRequests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
  });
  // Match a generated HTTP ALB origin, where randomUUID is unavailable.
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined });
  });
  await page.goto('/');
  await expect(page.getByText('SIMULATION ENVIRONMENT', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Simulated facility with moving mobile robots' }),
  ).toBeVisible();
  await expect(page.locator('#connection-label')).toHaveText('Simulation active');
  await expect(page.locator('#sim-clock')).toBeVisible();
  await expect(page.locator('.map-robot')).toHaveCount(3);
  const first = await page.locator('.map-robot').first().getAttribute('transform');
  await expect
    .poll(() => page.locator('.map-robot').first().getAttribute('transform'))
    .not.toBe(first);
  const metric = page
    .locator('.metric')
    .filter({ hasText: 'Confirmed transfers' })
    .locator('strong');
  await expect(metric).not.toHaveText('0', { timeout: 16000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({
    path: `.openai/local/simulation-${info.project.name}.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
  expect(apiRequests).toEqual([]);
});
test('simulation pause, advance and reset controls work', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#sim-clock')).toContainText('Running');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('#sim-clock')).toContainText('Paused');
  const before = await page.locator('#sim-clock').textContent();
  await page.waitForTimeout(1500);
  await expect(page.locator('#sim-clock')).toHaveText(before!);
  await page.getByRole('button', { name: 'Advance 1s' }).click();
  await expect(page.locator('#sim-clock')).not.toHaveText(before!);
  await page.getByRole('button', { name: 'Reset run' }).click();
  await expect(page.locator('#sim-clock')).toContainText('t+0s');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
});
test('two simulated reviewers authorize an inspection quarantine through the real controller', async ({
  page,
}) => {
  await page.goto('/#reviews');
  const card = page.locator('.review-card').filter({ hasText: 'Review inspection exception' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Approval recorded' })).toBeDisabled();
  await page.locator('#sim-reviewer').selectOption('b');
  await expect(page.locator('#identity')).toHaveText('Simulated reviewer B');
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(
    page
      .locator('table tbody tr')
      .filter({ hasText: 'quarantine' })
      .getByText('succeeded', { exact: true }),
  ).toBeVisible({ timeout: 12000 });
});
test('simulation scenarios generate safety reviews and are honestly identified on assurance', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('#sim-scenario').selectOption('equipment');
  await page.getByRole('link', { name: 'Decision workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review processing-line hold' })).toBeVisible();
  await page.locator('#sim-scenario').selectOption('interlock');
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.getByText('Dispatch inhibited', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Platform assurance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Isolated browser session' })).toBeVisible();
  await expect(page.getByText('Browser session memory · no durable retention')).toBeVisible();
});
test('missing simulation assets cannot fall back to a production control service', async ({
  page,
}) => {
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
  });
  await page.route('**/simulation/browser.js', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Simulation unavailable' })).toBeVisible();
  expect(apiRequests).toEqual([]);
  await expect(page.locator('#inhibit-button')).toBeDisabled();
});
