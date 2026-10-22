# Operations

## Provision the control service

Use a dedicated PostgreSQL 17 database, a confidential OIDC web client, an API resource audience and a TLS endpoint in your approved environment. Use Node.js 24. Run one controller per facility database. Inject runtime credentials from your secret manager.

| Setting                                | Required behavior                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| `PUBLIC_ORIGIN`                        | Exact HTTPS origin without a path or trailing slash                                  |
| `FACILITY_ID`                          | Authorized identifier beginning with a letter; must match tokens and persisted state |
| `DATABASE_URL`                         | Dedicated PostgreSQL database URL                                                    |
| `DATABASE_TLS`                         | Defaults to `true`; use trusted database certificates                                |
| `OIDC_ISSUER`                          | HTTPS issuer matching discovery metadata and token claims                            |
| `OIDC_AUDIENCE`                        | Resource API audience, distinct from the web client identifier                       |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Organization confidential web client credentials                                     |
| `SESSION_ENCRYPTION_KEY`               | Base64 encoding of 32 random bytes                                                   |
| `DEVICE_KEYS_JSON`                     | Device registry object; `{}` registers no sources                                    |
| `MODEL_REGISTRY_JSON`                  | Approved model registry object; `{}` registers no models                             |
| `SAFETY_POLICY_JSON`                   | Required explicit equipment policy described below                                   |
| `TELEMETRY_MAX_AGE_SECONDS`            | 5–120 seconds; default 30; requires synchronized device clocks                       |

Register the callback `PUBLIC_ORIGIN/auth/callback`. Resource tokens must include `sub`, `iat`, `exp`, `facility_id` and `roles` containing `viewer`, `operator`, `supervisor` or `admin`. Provider integrations must issue signed JWT access tokens; opaque access tokens are not accepted.

Generate the session key using your secret manager or:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Supply an explicit policy JSON object with all these numeric fields. Values must come from approved equipment operating envelopes; the project selects no operating thresholds for a facility.

| Field                         | Meaning                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `vibrationMax`                | Processing-line vibration alert threshold in mm/s                            |
| `lineTemperatureMax`          | Equipment temperature alert threshold in °C                                  |
| `zoneTemperatureMax`          | Zone temperature alert threshold in °C                                       |
| `minimumInspectionConfidence` | Accepted review threshold from 0 to 1                                        |
| `minimumRobotBattery`         | Minimum dispatch battery percentage                                          |
| `coolingSetpoint`             | Approved response target, below the zone alert threshold                     |
| `reviewTtlSeconds`            | Approval evidence lifetime, 30–3600 seconds                                  |
| `commandTtlSeconds`           | Dispatch and completion deadline, 5–300 seconds; size to the actual workflow |

Build, apply migrations, then start the service. Use the migration identity only for schema changes. Restrict the runtime database role to required state operations, audit INSERT/SELECT and advisory-lock access; it should not own audit tables or have DDL/TRUNCATE privileges. Verify audit protection using the runtime role. Production database TLS certificate chains must be trusted by Node; supply your organization's CA through `NODE_EXTRA_CA_CERTS` when needed.

Compose uses an external database and identity provider. Complete `.env` locally for Compose or inject equivalent environment variables. Do not commit completed credentials. Use image digests approved by your release process for production rollouts.

## Register a device

Each device registry entry has `kind` (`robot`, `processing-line`, `environment`, `inspection`), `secret` (at least 32 characters), `required` (defaults true), `capabilities`, and `destinations` for robot transfers. Execution requires both an HTTPS `commandEndpoint` and separate `commandSecret`. Monitoring-only sources can omit both. Capabilities are `transfer`, `hold`, `set-temperature` and `quarantine`.

Model entries contain `version`, `artifactSha256` (64 lowercase hex characters), `validationReference` and `approved`. The inspection device must report an exact approved tuple. Store the approval reference in your governed model management process and rotate configuration through a reviewed deployment.

## Signed ingress

Publish measured observations to `POST /api/device/telemetry` using `Content-Type: application/json`, `X-Device-ID` and `X-Device-Signature: sha256=<lowercase hex HMAC-SHA256>`. Sign the exact request bytes with the observation key. Envelopes contain `deviceId`, positive increasing `sequence`, ISO 8601 `timestamp`, and a discriminated `reading`.

| Kind              | Required reading fields                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `robot`           | `status`, `battery`, `position: {x,y,frame}`, `safetyStop`, `interlockReady`                                                 |
| `processing-line` | `vibration`, `temperature`, `runState`                                                                                       |
| `environment`     | `temperature`, `humidity`                                                                                                    |
| `inspection`      | UUID `inspectionId`, `bundleId`, `expectedCount`, `observedCount`, `confidence`, `modelId`, `modelVersion`, `artifactSha256` |

Use the generated OpenAPI document for enums and numeric limits. Device identities cannot publish a different reading kind. Sequence numbers are durable, shared across observations and asynchronous acknowledgements, and must survive device restarts. Coordinate one sequencer for each identity. Replayed sequence or regressing timestamp returns 409. Signature failures return 401. Unsupported schemas return 400. Payloads are bounded to 64 KiB.

`npm run device:publish -- <observation.json>` publishes a file supplied by your integration using `CONTROL_PLANE_URL` (HTTPS) and `DEVICE_SECRET`. This utility does not generate measurements. Integrate production devices directly with the protocol or through your equipment gateway.

## Execution gateway contract

The service posts JSON to each configured endpoint with `commandId`, `facilityId`, `deviceId`, `action`, `parameters`, `expiresAt`, `actor` and `approvals`. Headers include stable `Idempotency-Key` and `X-Command-ID` values equal to the command UUID, and `X-Control-Signature` signed with the separate command key.

The gateway must authenticate the body, enforce facility/device/action authorization, check expiry, verify local safety conditions and durably deduplicate the command identifier before actuating. It must never execute the same command twice, including after gateway restarts. The five-second HTTP timeout bounds acknowledgement, not the physical movement duration. Return `accepted` promptly if execution continues asynchronously.

Return a signed JSON acknowledgement with `commandId`, `deviceId`, `status` (`accepted`, `succeeded`, `failed`, `rejected`), current `timestamp` and optional `detail`. Sign exact response bytes using the observation key and `X-Device-Signature`. A successful HTTP status without a valid signed acknowledgement does not establish an outcome.

For asynchronous results, post a signed envelope to `/api/device/acknowledgements` with `deviceId`, next `sequence`, current `timestamp` and nested `acknowledgement`. The nested result must match the device and previously transmitted command. HTTP acceptance of ingress is 202; it is not confirmation that equipment acted.

## Release and recovery

The service starts inhibited. Enroll required devices and receive fresh signed observations. A supervisor then releases dispatch with an operational reason. Each action is rechecked at transmission. Use `inhibit` to stop new dispatch; stop moving equipment through its physical safety controller.

If delivery or completion is uncertain, inspect the equipment and gateway's durable command ledger. Submit a signed final result through the acknowledgement endpoint after reconciliation. An operator cannot mark success locally or reset a counter. Release inhibition only after all uncertain requests are reconciled and required devices are fresh. Never retransmit an uncertain physical request under a new identifier to bypass the hold.

Restarting invalidates pending approval votes and cancels unsent queued commands. Interrupted transmissions become uncertain. A signed final acknowledgement can reconcile those commands after restart. Back up database state and audit together. Validate a restored copy before any service release.

## Health and audit

`/health/live` reports process liveness. `/health/ready` verifies controller ownership and database availability. `/api/platform`, `/api/audit` and `/metrics` require an authenticated principal. Readiness does not indicate that all equipment is connected; inspect per-device freshness and dispatch inhibition separately. Configure alerting for readiness loss, stale required devices, uncertain outcomes, rejected ingress and command deadlines.

Export paginated audit records from `/api/audit?after=<sequence>&limit=<1..1000>`. The console exports up to 10,000 records per download and identifies truncation. Verify an exported chain with `npm run audit:verify -- <audit.json>` and independently retained audit heads. A hash chain does not protect against a database administrator rewriting the full ledger and head; retain external copies according to organizational policy.

## Version 2 transition

Stop the prior controller. Preserve its database and audit exports. Provision a clean version 2 database and enroll real identities, sources, model lineage and approved policy. Migrations preserve prior records; the service deliberately refuses to adopt an old operating checkpoint. Do not delete a production audit ledger to force a migration. Version 1 operational snapshots are not automatically imported.
