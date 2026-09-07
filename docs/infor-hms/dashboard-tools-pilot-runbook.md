# Dashboard tools pilot runbook

## Initial dashboard slice (U11-A)

Status: fixture-verified browser proof only. This slice exercises the reviewed
`AdminDashboardPage` and its real query/provider path with deterministic,
public-safe loopback transports. It does not claim live mail, PMS, model,
database, population, or release/agent activation proof.

### Run

Run from the worktree with the reviewed fail-closed gate:

```bash
env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=test CI=1 \
  AWS_EC2_METADATA_DISABLED=1 \
  bash apps/server-pilot/scripts/reservation-pilot-gate.sh browser dashboard
```

The gate validates the literal fake-fixture contract, requires the Chromium
network namespace to expose loopback only, starts Vite on
`http://127.0.0.1:4179`, and runs the exact
`reservation-tools-pilot/dashboard` Playwright slice. The fixture transport
refuses non-loopback fetches and exposes only session, connection-default, and
aggregate dashboard reads; it has no mutation or live-service path.

The journey covers:

- desktop and mobile layouts with keyboard-visible controls and 44px minimum
  control, disclosure, and option targets;
- authorized Centurion/current data and the Research cohort;
- an explicit historical cutoff with unavailable folder/classification
  evidence;
- a bounded 28-day outage/error state retaining the observed snapshot and
  stating that no demo data is substituted; and
- unauthorized access redirecting to general settings without an aggregate
  dashboard request.

### Evidence and limits

Trace, video, and screenshots are written only under:

```text
.private/centurion-dashboard-tools-execution/u11a-browser-artifacts/
```

These artifacts are runtime evidence, not public fixtures. Preserve their
expiry and access controls; do not copy raw browser state, cookies, response
bodies, mailbox content, or credentials into Git or reports. The private
U11-A report records exact commands, counts, and artifact paths.

### Rollback and activation bounds

This slice has no production activation, registry entry, send path, write
adapter, or shared-service mutation. To roll it back, remove the U11-A fixture
spec/config/assets and the initial runbook section, then restore the U1 gate
mapping/environment edits; deleting the ignored artifact directory is safe
after retention obligations are met. Stopping the gate terminates the local
Vite/Chromium processes. Later dashboard release, live activation, tool/agent
release, shadow/draft journeys, and write capabilities require separate
reviewed gates and are not enabled by this proof.
