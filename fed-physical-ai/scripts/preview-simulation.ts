import { createSimulationPreview } from '../src/simulation/preview-server.js';
if (process.argv.includes('--bedrock')) process.env.BEDROCK_ENABLED = 'true';
const server = createSimulationPreview();
server.listen(4174, '127.0.0.1', () =>
  console.log(
    `Simulation preview: http://localhost:4174${process.env.BEDROCK_ENABLED === 'true' ? ' (Bedrock bridge enabled)' : ''}`,
  ),
);
