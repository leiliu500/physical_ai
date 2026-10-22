import { BedrockAdvisor, bedrockSettings } from '../src/ai/bedrock.js';
const settings = bedrockSettings({ ...process.env, BEDROCK_ENABLED: 'true' });
try {
  const result = await new BedrockAdvisor(settings).plan(
    'This synthetic facility has zero devices and zero pending reviews. Summarize missing setup before dispatch. Return an empty recommendations array.',
    {
      source: 'simulation',
      facilityId: 'SIM-SMOKE-CHECK',
      dispatchInhibited: true,
      devices: [],
      reviews: [],
    },
  );
  console.log(
    JSON.stringify({
      modelId: result.modelId,
      region: result.region,
      source: result.source,
      summary: result.summary,
      usage: result.usage,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Bedrock smoke test failed.');
  process.exitCode = 1;
}
