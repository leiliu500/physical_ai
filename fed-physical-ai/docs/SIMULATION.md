# Simulation workspace

The hosted Site runs an explicitly labeled browser-local simulation. It produces activity immediately without PostgreSQL, organization OIDC, a trained model or physical hardware. Each tab has an independent run. Reloading or resetting clears its state and audit history.

## Run locally

Use Node.js 24 and install dependencies, then run:

```sh
npm ci
npm run simulation
```

Open `http://127.0.0.1:4174`. `npm run build:simulation` emits the separate simulation artifact in `out/`. The ordinary production build remains in `dist/`, and the production container excludes simulation modules. URL query parameters cannot activate the simulator in the production console.

## Activity and controls

The workspace starts three mobile robots transferring synthetic cash containers between receiving, processing and secure storage. A processing line, environmental sensor and inspection source publish generated observations every second. A facility map displays robot positions and an activity stream records generated events. Transfer counts increase only after the simulation gateway emits a completion acknowledgement through the shared controller.

- **Pause / Resume:** Stop or restart periodic simulation advances. The production controller's wall-clock freshness and deadline checks still apply; resetting starts a fresh run after an extended pause.
- **Advance 1s:** Advance the simulation once, including while paused.
- **Reset run:** Clear this browser session and restart the active workload.
- **Reviewer:** Select simulated reviewer A or B to exercise the distinct-person quarantine workflow. These are synthetic identities, not signed-in production users.
- **Scenario:** Apply normal operation, equipment fault, temperature excursion, inspection exception or robot interlock. Selecting a scenario takes control from the initial automatic sequence.

The initial sequence opens an inspection exception immediately, an equipment event after 18 simulation seconds and a temperature event after 38 seconds. Reviews can approve a line hold or temperature response. Quarantine needs approval from both simulated reviewers. Robot interlock inhibits new dispatch and stops the affected simulated robot; returning to normal requires an explicit dispatch release.

## Relationship to production

`src/simulation` supplies only the generated devices, session memory store, synthetic reviewer identities and in-memory gateway. It imports the same TypeScript `Controller` used by the production service. Device envelopes pass signature, schema, freshness and replay validation; reviews use the same evidence binding and quorum rules; commands use the same queued, accepted, completed and uncertain transitions. The browser build supplies a simulation-only SHA-256/HMAC compatibility layer. Production continues to use Node's cryptography implementation.

The simulator does not make network requests to a control API or equipment gateway. It is not a hardware-in-the-loop environment or evidence of model performance, facility throughput or safety certification. Simulation keys and model digests are public fixtures, unsuitable for any real integration. The assurance page identifies these limits, and state exports are marked as simulation data.

The run pauses at approximately 6,000 audit records to bound session memory. Export records before reset if needed; browser memory is not a durable audit store. The existing private Site's access policy is preserved.
