# Validation scope

Verification covers TypeScript compilation, control decisions, authenticated HTTP behavior, the signed gateway adapter, PostgreSQL transactions, browser connection states and the isolated simulation. Production tests use fixtures under `tests/`; the explicitly generated simulation is under `src/simulation/`. Both are excluded from the production runtime image.

## Recorded local verification — 2026-10-21

| Check                                                                               | Result                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Node.js 24.22.0 TypeScript compilation and clean build                              | Passed                                                                    |
| Backend and simulation checks with isolated PostgreSQL 17, migrations applied twice | 44 passed, zero skipped                                                   |
| Desktop and mobile Microsoft Edge browser checks                                    | 18 passed: 8 production console checks and 10 simulation checks           |
| Production dependency audit                                                         | Zero reported vulnerabilities                                             |
| Formatting                                                                          | Passed                                                                    |
| Docker image build and deployed equipment integration                               | Not run; Docker and physical integrations unavailable in this environment |

## Automated checks

- Empty startup: no enrolled measurements, invented histories or completed actions.
- Device signature, freshness, durable sequence replay protection and approved model lineage.
- Dispatch release, device capabilities, allowed destinations, interlock and battery checks.
- Actor-scoped idempotency, two distinct quarantine reviewers and evidence invalidation.
- Queued versus accepted versus completed actions; unsigned responses cannot confirm success.
- Unknown delivery, overdue completion, stale sources and restart recovery inhibit dispatch.
- Signed JWT issuer, resource audience, facility, roles and encrypted session CSRF checks.
- Real PostgreSQL exclusive ownership, atomic rollback, restart recovery and append-only audit triggers.
- Desktop and mobile console states, organization sign-in, unavailable service, empty fleet and operational ledger rendering.
- Clean build removes obsolete outputs; formatting and production dependency audit support release review.
- Simulation device movement, acknowledged completions, pause/step/reset, interlock recovery and distinct reviewer quorum.
- Simulation-only browser cryptographic hashes match the production implementation; production static assets exclude the simulation bundle.

Run `npm test` with `TEST_DATABASE_URL` pointing to an isolated migrated database to include real database integration. A run without that variable intentionally reports a skipped database suite. CI provisions PostgreSQL 17 and uses Node.js 24. Production browser tests use a test-only static transport, while simulation browser tests exercise the built simulator directly and verify that it contacts no operational API. These tests do not replace physical integration tests.

## Commissioning still required

No physical hardware, organization IdP, approved model artifact or production database is connected by the repository. Before operating equipment, qualify the device gateway against the published protocol, including restart-safe deduplication, signed asynchronous outcomes and local emergency-stop behavior. Validate sensor calibration, coordinate frames, model performance, decision thresholds and command deadlines using the actual equipment.

Validate the chosen OIDC provider's claim mapping, TLS and certificate trust, secret rotation, database runtime permissions, backup restore, load capacity, observability and incident response in the deployment environment. Container configuration is provided; a successful Docker build is separate evidence from compiler and application tests. This release does not claim Federal Reserve approval, regulatory certification, safety certification or remote model attestation.
