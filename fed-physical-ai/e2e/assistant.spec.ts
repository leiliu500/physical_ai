import { test, expect } from '@playwright/test';
test.use({ baseURL: 'http://127.0.0.1:4174' });
test('assistant identifies a disabled Bedrock backend without manufacturing a response', async ({
  page,
}) => {
  await page.goto('/#assistant');
  await expect(page.getByRole('heading', { name: 'AI operations assistant' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate recommendations' })).toBeDisabled();
  await expect(
    page.getByText('Bedrock is not enabled on this server.', { exact: false }),
  ).toBeVisible();
  await expect(page.locator('.ai-result')).toHaveCount(0);
});
test('assistant preserves typed requests through simulation ticks and displays advice without executing it', async ({
  page,
}) => {
  await page.route('**/simulation/ai/status', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        modelId: 'openai.gpt-oss-120b-1:0',
        region: 'us-gov-west-1',
      }),
    }),
  );
  await page.route('**/simulation/ai/plan', async (route) => {
    const input = route.request().postDataJSON() as {
      prompt: string;
      context: { source: string; reviews: { id: string }[] };
    };
    expect(input.context.source).toBe('simulation');
    expect(input.prompt).toBe('Explain the inspection exception and suggest a review.');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: '4be2aa28-233d-4c49-968a-e5880ae7f69c',
        modelId: 'openai.gpt-oss-120b-1:0',
        region: 'us-gov-west-1',
        source: 'simulation',
        createdAt: new Date().toISOString(),
        contextDigest: 'a'.repeat(64),
        usage: { inputTokens: 30, outputTokens: 20 },
        summary: 'Inspect the pending count discrepancy.',
        observations: ['A synthetic count mismatch is pending.'],
        recommendations: [
          {
            kind: 'review',
            proposalId: input.context.reviews[0].id,
            rationale: 'Open the evidence and collect distinct reviewer approvals.',
          },
        ],
        limitations: ['Synthetic data only.'],
      }),
    });
  });
  await page.goto('/#assistant');
  const prompt = page.getByLabel('Operational request');
  await prompt.fill('Explain the inspection exception and suggest a review.');
  await page.waitForTimeout(1600);
  await expect(prompt).toHaveValue('Explain the inspection exception and suggest a review.');
  await page.getByRole('button', { name: 'Generate recommendations' }).click();
  await expect(
    page.getByText('Inspect the pending count discrepancy.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('No command was dispatched by this model response.')).toBeVisible();
  await page.getByRole('button', { name: 'Open decision workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review inspection exception' })).toBeVisible();
});
