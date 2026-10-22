# Validation scope

Verification covers TypeScript compilation, control decisions, authenticated HTTP behavior, the signed gateway adapter, PostgreSQL transactions, Bedrock response validation, browser connection states, the isolated simulation and offline Terraform plans. Production tests use fixtures under `tests/`; the explicitly generated simulation is under `src/simulation/`. Both are excluded from the production runtime image.

## Recorded verification — 2026-10-22

| Check                                                                                                               | Result                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js 24.22.0 TypeScript compilation and clean build                                                              | Passed                                                                                                                                                             |
| Backend, Bedrock adapter, ECS bootstrap and simulation checks with isolated PostgreSQL 17, migrations applied twice | 62 passed, zero skipped; 9 focused simulation/hosted API checks also passed after the HTTP browser compatibility change                                            |
| Desktop and mobile Microsoft Edge browser checks                                                                    | 26 passed: 8 production console, 14 simulation and 4 assistant checks                                                                                              |
| Terraform 1.16.2 / AWS provider 6.70.0 formatting, validation and mocked plan tests                                 | Passed; 7 deployment tests, including GovCloud partition checks                                                                                                    |
| Production dependency audit                                                                                         | Zero reported vulnerabilities                                                                                                                                      |
| Formatting                                                                                                          | Passed                                                                                                                                                             |
| Simulation Docker image build and ECS deployment                                                                    | Passed through GovCloud CodeBuild and ECR; ECS task revision 4 healthy behind the ALB                                                                              |
| Deployed equipment integration                                                                                      | Not run; no physical equipment connected                                                                                                                           |
| AWS GovCloud identity, model metadata and real Bedrock Converse smoke test                                          | Passed in `us-gov-west-1` using `openai.gpt-oss-120b-1:0` and the Markdown prompt; 1,338 input / 184 output tokens on an empty synthetic snapshot                  |
| Live ECS HTTP API and Bedrock inference                                                                             | Passed; exact model and region, valid empty synthetic snapshot response, 1,338 input / 191 output tokens                                                           |
| Live ALB desktop/mobile Edge verification                                                                           | Passed over HTTP: three moving robots, acknowledged transfers, no page errors or horizontal overflow; browser Bedrock request used 1,971 input / 354 output tokens |
| Simulation remote Terraform state                                                                                   | Migrated to versioned S3 with KMS encryption and S3 locking; deployed resource state verified                                                                      |

The separate `infra/simulation` stack was applied in GovCloud West. It runs the browser-local synthetic facility and a server-side Bedrock bridge on ECS Fargate. The generated HTTP ALB endpoint is restricted to `3.83.200.219/32`; see the [simulation deployment guide](../../infra/simulation/README.md). The pinned image digest is `sha256:c2acfca21c7c9740cf4a1e7741191fd9950cc0b37e6b903ff07f52a8e0ced26e`.

The robot icon release uses shared inline SVG geometry across the facility map, fleet cards and device tables. Seven visual states were inspected: moving, idle, charging, fault, stopped, offline and unknown. The 22 existing desktop/mobile browser checks passed. Additional checks against the deployed ALB confirmed moving robots, safety-stop icons and fleet icons at both viewport sizes, with no page errors or horizontal overflow.

Operation-dialog regressions preserve the transfer reference, selected destination and dispatch reason when fields are clicked. The transfer check retains input through periodic workspace refreshes, submits `SIM-TRANSFER-001` and verifies exactly one completed transfer to Secure storage. This workflow also passed against the deployed AWS ALB on desktop and mobile, with no page errors.

The final refreshed Terraform plan reported no changes. ECS reported one running task, zero pending tasks and a completed rollout; the load balancer target was healthy.

The production control stack under `infra/terraform` has not been deployed. Offline tests use mocked Bedrock transports and Terraform providers; the recorded live checks above establish access only for the selected GovCloud simulation deployment.

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
- Simulation UUID generation uses cryptographically random bytes and works on the requested HTTP ALB origin without the HTTPS-only browser UUID API.
- Bedrock exact-model requests, invalid outputs and unknown identifiers, failed credentials, bounded context, durable audit before inference and no automatic command creation.
- Runtime Secrets Manager parsing, password URL encoding and rejection of injected runtime settings.
- Assistant input survives simulation updates; recommendations open human review without executing an action.
- Terraform private networking, encrypted persistence, exact-model IAM, immutable image release, disabled inference permissions and distinct OIDC audiences.
- GovCloud defaults, matching regional certificate/secret partitions and packaging the Markdown system prompt with the server artifact.
- Terraform-managed image verification, bootstrap inclusion, explicit Node server startup and ECS health waiting. Bootstrap start failures, timeouts, nonzero exits and missing completion evidence prevent release.

Run `npm test` with `TEST_DATABASE_URL` pointing to an isolated migrated database to include real database integration. A run without that variable intentionally reports a skipped database suite. CI provisions PostgreSQL 17 and uses Node.js 24. Production browser tests use a test-only static transport, while simulation browser tests exercise the built simulator directly and verify that it contacts no operational API. These tests do not replace physical integration tests.

## Commissioning still required

No physical hardware, organization IdP, approved model artifact or production database is connected by the repository. Before operating equipment, qualify the device gateway against the published protocol, including restart-safe deduplication, signed asynchronous outcomes and local emergency-stop behavior. Validate sensor calibration, coordinate frames, model performance, decision thresholds and command deadlines using the actual equipment.

Validate the chosen OIDC provider's claim mapping, TLS and certificate trust, secret rotation, database runtime permissions, backup restore, load capacity, observability and incident response in the deployment environment. Container configuration is provided; a successful Docker build is separate evidence from compiler and application tests. This release does not claim Federal Reserve approval, regulatory certification, safety certification or remote model attestation.
