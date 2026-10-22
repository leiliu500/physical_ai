import { createSimulationPreview } from '../src/simulation/preview-server.js';
const publicOrigin = process.env.SIMULATION_PUBLIC_ORIGIN;
if (!publicOrigin)
  throw new Error('SIMULATION_PUBLIC_ORIGIN is required for the hosted simulation.');
const server = createSimulationPreview(undefined, { publicOrigin });
server.listen(4174, '0.0.0.0', () => console.log('Simulation service listening on port 4174.'));
const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
