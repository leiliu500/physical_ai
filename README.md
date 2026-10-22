# Physical AI Operations

The TypeScript application is in [fed-physical-ai](fed-physical-ai/README.md). It provides authenticated fleet and facility monitoring, model-provenance checks, governed reviews and signed physical command tracking.

Version 2 requires organization OIDC, PostgreSQL, approved safety policy and registered device integrations. It starts empty and does not manufacture observations or execution results. See the application [deployment guide](fed-physical-ai/docs/OPERATIONS.md) and [validation scope](fed-physical-ai/docs/VALIDATION.md).

A separate [simulation workspace](fed-physical-ai/docs/SIMULATION.md) now provides moving robots, sensor trends, inspection exceptions and governed reviews without hardware. From `fed-physical-ai`, use Node.js 24 and run `npm run simulation`. Simulation is explicitly labeled and isolated from the production deployment.
