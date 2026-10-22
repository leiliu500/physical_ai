# Reserve Physical AI Operations

TypeScript operations software for authenticated device monitoring, governed decisions and accountable physical execution in cash processing and facility operations. The production service starts with an empty operating state and requires OIDC identity, PostgreSQL persistence, signed device ingress and configured HTTPS execution gateways. The separate simulation workspace supplies generated activity without hardware.

The console includes fleet operations, equipment and environmental monitoring, model-backed inspection results, supervisor reviews, execution tracking and an audit ledger. Measurements are supplied by registered sources. Threshold decisions use an explicit facility policy. Inference runs in your inspection system; the control plane verifies the reported model version and artifact digest against an approved registry.

## Simulation workspace

A separate, clearly labeled simulation now powers the hosted Site with moving robots, sensor trends, inspection exceptions and interactive reviews. Run `npm run simulation` on Node.js 24 to open it at `http://127.0.0.1:4174`. It reuses the production controller with browser session memory and a simulation-only gateway. See [SIMULATION.md](docs/SIMULATION.md) for pause, reset, scenarios and the two-reviewer workflow.

## Production operating guarantees

- The production service has no generated device motion, scenario injection, local identity selection or browser execution engine. Simulation assets are emitted separately in `out/`.
- Commands require an authenticated role, current observations, approved capabilities, idempotency keys and a released dispatch boundary.
- Robot dispatch checks reported hardware stop, interlock, idle state and battery policy. Physical safety enforcement remains in certified local controllers.
- Quarantine requires two distinct authenticated supervisors. Approval tokens bind the evidence revision and policy; changed evidence clears approvals.
- Queuing and gateway acceptance do not count as completion. Only a signed successful gateway result increments completion metrics.
- Unknown delivery or overdue completion inhibits further dispatch. Automatic retries cannot duplicate a possibly executed physical action.
- State, sequence protection, operator receipts and audit records commit together in PostgreSQL. Startup requires exclusive controller ownership and resets dispatch authorization.

These controls are implemented software behavior, not a certification or an authorization to operate Federal Reserve infrastructure. No actual facility, identity provider, model artifact or device connection is provisioned in the repository.

## Install and validate

Use Node.js 24 LTS and PostgreSQL 17 for the production service. The simulation needs only Node.js 24 for its build and preview. All authored application, utility and test logic is TypeScript; JavaScript under `build/`, `dist/` and `out/` is generated output.

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run test:e2e
```

The database integration suite requires a dedicated `TEST_DATABASE_URL`, applied migrations and `DATABASE_TLS=false` only for an isolated unencrypted test database. PostgreSQL tests report a skip when no test database is supplied. Browser tests use a test-only transport fixture under `tests/support`; it is excluded from the runtime image.

## Configure and run

Complete the settings described in [OPERATIONS.md](docs/OPERATIONS.md) using organization secrets and approved equipment policy. `.env.example` is a configuration template with no runnable credentials or selected safety thresholds. `npm start` reads the process environment; it does not automatically load `.env`.

```sh
npm run build
npm run db:migrate
npm run start:service
```

For a container deployment backed by your managed PostgreSQL and IdP:

```sh
docker compose build
docker compose run --rm --no-deps app node build/scripts/migrate.js
docker compose up -d
```

The HTTPS proxy and service share the configured `PUBLIC_ORIGIN`. The production console calls the same-origin API; serving its `dist/` assets alone shows service unavailability. The independently built simulation in `out/` runs locally in each browser without an API backend.

## Documentation

- [Architecture and trust boundaries](docs/ARCHITECTURE.md)
- [Deployment, device protocol and recovery](docs/OPERATIONS.md)
- [Verification scope and remaining commissioning work](docs/VALIDATION.md)
- OpenAPI contract: `dist/openapi.json` after a build

Version 1 checkpoints are intentionally incompatible with version 2. Preserve their audit records and provision a clean operating database; no fabricated readings or prior approvals are imported automatically.
