# Dashboard tools pilot runbook

## Initial dashboard slice (U11-A)

Status: current production-style browser proof GREEN. This slice exercises the reviewed
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

- desktop (1280x900) and mobile (390x844) layouts using the production
  Tailwind Vite plugin and imported production `app/globals.css`; the former
  hand-authored fixture utility CSS has been removed;
- keyboard-only cohort/window menus, disclosure Enter/Space toggles, tab order,
  `:focus-visible`, return focus, and refresh/error focus retention at both
  viewport sizes;
- authorized Centurion/current data and the Research cohort;
- an explicit historical cutoff with unavailable folder/classification
  evidence;
- a bounded 28-day outage/error state retaining the observed snapshot and
  stating that no demo data is substituted; and
- unauthorized access redirecting to general settings without an aggregate
  dashboard request.

The transport validates the actual tRPC batch envelope and finite
cohort/window/cutoff values. The latest/undefined SuperJSON form is accepted
only with `observationCutoff: null` and the exact
`meta.values.observationCutoff: ["undefined"]` marker; an explicit ISO cutoff
is accepted without metadata. Missing cutoffs, malformed/unknown metadata, and
other malformed or non-finite inputs return 400 with a null query receipt;
valid 28-day outage input returns 503. The exact browser test covers ten such
400 probes. Request receipts retain only method/path/status and normalized
query metadata, never request bodies.

### Evidence and limits

Trace, video, and screenshots are written only under:

```text
.private/centurion-dashboard-tools-execution/u11a-browser-artifacts/
```

Fresh production-theme screenshots are:

```text
.private/centurion-dashboard-tools-execution/u11a-browser-artifacts/reservation-tools-pilot-reservation-tools-pilot-dashboard/dashboard-desktop.png
.private/centurion-dashboard-tools-execution/u11a-browser-artifacts/reservation-tools-pilot-reservation-tools-pilot-dashboard/dashboard-mobile.png
```

The focused metadata RED run was consumed as private diagnostic evidence before
the fresh green rerun. The current desktop/mobile and test-finished captures
are production-theme artifacts from the post-repair GREEN run. The former 35px
target failure was caused by the
production `html { font-size: 80% }` root scale combined with rem-based
`min-h-11`; the target owner replaced the ten page-local floors with explicit
`min-h-[44px]` and added a production-root-scale regression. No global CSS,
fixture threshold, config, or gate change was made.

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
reviewed gates and are not enabled by this proof. The exact dashboard gate is
now fresh green for this slice; later activation bounds remain unchanged.
