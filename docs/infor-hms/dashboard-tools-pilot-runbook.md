# Dashboard tools pilot runbook

## Owner correction — live PMS is the acceptance target

- The requested deliverable is each read-only tool working against the **live
  PMS**, with a recording of that actual PMS interaction and verified result.
  Local implementation or a synthetic journey is not delivery of that tool.
- Perform PMS discovery/exploration in the live system using the supplied
  credentials and existing read-only controls. All current application users
  already have the required configured tool/data access; do not ask again for
  per-user roles or allowlists.
- Requested recordings must be live PMS recordings. Do not create further
  synthetic recording deliverables unless the owner explicitly requests them.
  Existing synthetic archives below are retained only as historical test evidence.
- Unit/disposable-DB regression checks remain secondary engineering evidence;
  they cannot establish that a tool works in the live PMS. Historical email
  backtesting is separate and must not postpone direct live tool exploration.
- Correction to the prior toolkit summary: implementation is partial, and no
  fresh live-PMS execution or live-PMS recording of this new toolkit was completed
  in the run. Some entries still return unavailable states or lack live-source
  wiring; they are not finished working readers.
- Prioritize live read-tool discovery, execution, fact verification, and PMS
  videos before further drafting-agent work. Preserve read-only side-effect
  controls and keep credentials out of captures, logs, and Git.

## Latest local checkpoint — 2026-09-10

Runtime/test source: `eff22bce3f9e675e7006c0757e3ed7c7274538ba`.
The local verification sweep is complete; **the full three-phase plan is not**.

| Phase             | What is available locally                                                                                                                           | What is not yet proved                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Dashboard         | Executive metrics, charts, cohorts, exports, and explicit unavailable states; server/DB and real-component browser checks pass.                     | Live-data/deployed readiness is not established by these fixture checks.                         |
| Read-only toolkit | Independent typed reads and audited local/DB paths for reservation, finance, documents, rates/availability, linked context, and approved knowledge. | Current live PMS capability and the real-email Phase 2/B release gate remain unqualified.        |
| Drafting agent    | Candidate/review UI, editor preservation, worker/approval safeguards, and synthetic private evaluation have local proof.                            | U5 PMS-to-prepared integration remains incomplete; no complete live drafting or Phase 2/B claim. |

### Historical synthetic recordings — not live PMS acceptance

These recordings use real components with synthetic loopback HTTP. They are
separate from the disposable-DB proofs, not a joined live browser/server test.

- Dashboard desktop: [video](../../.private/centurion-dashboard-tools-execution/final-browser-dashboard.UmKlRT/browser-artifacts/reservation-tools-pilot-re-667e8-ols-pilot-dashboard-desktop/video.webm) · [trace](../../.private/centurion-dashboard-tools-execution/final-browser-dashboard.UmKlRT/browser-artifacts/reservation-tools-pilot-re-667e8-ols-pilot-dashboard-desktop/trace.zip).
- Dashboard mobile: [video](../../.private/centurion-dashboard-tools-execution/final-browser-dashboard.UmKlRT/browser-artifacts/reservation-tools-pilot-re-e608d-ools-pilot-dashboard-mobile/video.webm) · [trace](../../.private/centurion-dashboard-tools-execution/final-browser-dashboard.UmKlRT/browser-artifacts/reservation-tools-pilot-re-e608d-ools-pilot-dashboard-mobile/trace.zip).
- Existing documents: [video](../../.private/centurion-dashboard-tools-execution/final-browser-documents.mKmWGq/browser-artifacts/reservation-tools-pilot-reservation-tools-pilot-documents/video.webm) · [trace](../../.private/centurion-dashboard-tools-execution/final-browser-documents.mKmWGq/browser-artifacts/reservation-tools-pilot-reservation-tools-pilot-documents/trace.zip).
- Draft review and manual fallback: [video](../../.private/centurion-dashboard-tools-execution/final-browser-pilot.mDP4YW/browser-artifacts/reservation-tools-pilot-reservation-tools-pilot-pilot/video.webm) · [trace](../../.private/centurion-dashboard-tools-execution/final-browser-pilot.mDP4YW/browser-artifacts/reservation-tools-pilot-reservation-tools-pilot-pilot/trace.zip).

Complete directories were copied and compared before the next browser run;
video/trace hashes and exact command output are in the
[private final verification receipt](../../.private/centurion-dashboard-tools-execution/final-verification.VE49VH/README.md).
Representative screenshots were inspected; full videos were not manually watched.

### Evidence and remaining work

- Fresh checks passed: 13 guarded unit slices, 10 guarded disposable-PG16
  slices, all 22 dashboard frontend tests, both builds, all three browser
  slices, and the focused strict fixture-config typecheck. These are scoped
  gates, not a claim that every monorepo test or the full mail typecheck ran.
- The private historical receipt passes read-only integrity verification but
  still contains **zero runnable cases**. Missing pinned pre-reply reference
  matches and source/direction links are evidence gaps, not user-access denials.
- All current authenticated application users have all configured tools/data,
  including finance and Research. Owner double-check at handoff only; no extra
  role/allowlist approval is pending.
- U5 is parked under the plan's bounded retry/advisory policy. The previous
  installed `asm-exec` pin mismatch also leaves remote capability unknown;
  no remote repair, live activation, deployment, merge, push, or PR occurred.
- See the [execution ledger](../superpowers/plans/handoff-reports/2026-09-07-centurion-dashboard-tools-execution.md)
  for accepted repairs, remaining qualification requirements, and evidence
  boundaries. The [export correctness note](../solutions/logic-errors/dashboard-cached-export-after-failed-refetch.md)
  and [dashboard vocabulary](../../CONCEPTS.md#executive-dashboard-reports)
  preserve the completed compounding work.

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
- all authenticated pilot users retaining aggregate-dashboard access. Missing
  current identity/access remains separately covered by server/frontend tests;
  the browser journey no longer treats an arbitrary authenticated user as denied.

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

The shared directory is reused and replaced by subsequent browser slices.
Use the preserved desktop/mobile directories linked in **Historical synthetic
recordings** above for the production-theme screenshots, videos, and
traces; do not infer freshness from this shared path.

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

## U11 final integrated handoff (2026-09-10)

Disposition: local proof only. The integrated DB slice reuses existing
server-pilot admission, read, document, shadow, mailbox-context-authorized mail, and queue
components. It does not enable a live model/PMS route, promote fixtures, or
join browser output to a production server session.

### Three-phase human evidence check

One authorized human checks each phase against its named receipts. The labels
below are phase responsibilities, not three new staff owners or new access
gates. A later phase cannot be promoted from a lower-phase fixture receipt.

| Phase                | Human check                                                                                                                                                        | Implemented                                                                                                   | Locally verified / current proof                                                                                                                                                            | Live enablement                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Dashboard         | Confirm dashboard cutoff/cohort and document receipts remain source-bound and manual when evidence is unavailable.                                                 | Existing dashboard/document UI, read admission, document service, and loopback fixture.                       | `browser dashboard` (desktop + mobile) and `browser documents`; model-free document DB slice.                                                                                               | Not enabled; browser transport is loopback-only and synthetic.                                                                                                                        |
| 2. Read-only toolkit | Confirm read receipts, causal shadow separation, and mailbox-context mail send/queue receipts before any release decision.                                         | `apps/server-pilot/tests/reservation-tools-pilot-integration.test.ts`; exact `db:integration` gate.           | Three DB cases pass on owned disposable PG16: model-free document/manual fallback, private future-shadow matching/scorecard, and injected-session `mail.send` → outbound queue → fake SMTP. | Not enabled; the SMTP edge, document bytes, shadow model/labels, and seeded rows are synthetic/local.                                                                                 |
| 3. Drafting agent    | Require accepted normal worker + approval/current-authority evidence and resolve parked PMS-to-prepared work before claiming an AI journey or Phase 2/B readiness. | Accepted U6 local worker/approval evidence and existing browser pilot remain separate; U13 is synthetic-only. | `browser pilot` and retained U6 receipts; no new joined browser/server proof in U11. U5 I3 remains PARKED LOCAL/advisory-used.                                                              | No live enablement proved; this checkout has no live activation and remote state is unknown. No live model, PMS, production outbox, autonomous sender, or Phase 2/B capability claim. |

### Five-path proof boundaries

| Journey               | Actual path                                                                                                                                                                              | Seeded/direct lower edge                                                                                      | Claim allowed                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard             | Fixture-session UI/provider → `adminDashboard` reads.                                                                                                                                    | Vite loopback fixture; no DB/outbox.                                                                          | Desktop/mobile UI and transport contract only; no login-authentication claim.                                                                               |
| Documents             | `issueReadAdmission` → `executeReadToolRun` → `createExistingDocumentService` → authorized artifact reader.                                                                              | Constructed test admission/context and `FakeS3Storage`; existing browser UI uses its own fixture HTTP bridge. | Typed model-free read and `SOURCE_UNAVAILABLE`/`manual_required`; no PMS-positive or draft claim.                                                           |
| Shadow                | `freezeShadowInput` → seal → later-thread matcher → mode-specific scorecard.                                                                                                             | Direct production pure functions with synthetic in-process route/model/label.                                 | Causal nondisplay and mode separation; U13 local synthetic only.                                                                                            |
| Mail-only manual send | Seeded thread/inbound message → `callerFor('user-navaai')` with injected session user and no login transport → actual `caller.mail.send` → message/outbound queue → `FakeSmtpTransport`. | Owned disposable PG16 and fake SMTP; `UNDO_SEND_SECONDS=0` is scoped/restored.                                | Mailbox-context authorization plus the real route/queue boundary only; it is not login authentication and not the supported AI draft/approval/send journey. |
| Drafting agent        | Accepted U6 configured worker/factory/caller and approval/send receipts; separate browser fixture pilot.                                                                                 | Lower synthetic model/SMTP in accepted U6 receipts.                                                           | U6 local-only evidence; never call it a joined browser-to-production proof.                                                                                 |

PMS/manual remains a separate parked boundary, not a sixth completed path:
the existing source-unavailable/manual surface has no PMS-positive fixture,
and U5 PMS-to-prepared remains incomplete and PARKED LOCAL/advisory-used.

### Kill-switch, rollback, and limitations

The v3 qualifier is a one-shot local Node process with no daemon, model,
network, PMS, mail, registry, or production-write path. Stop an in-progress
`build` or `verify` with `Ctrl-C`; publication occurs only after all four files
and semantic contracts/hashes validate. An existing sealed run ID is refused,
and an interrupted build cannot replace the historical v1/v2 outputs. Preserve any exact `.tmp`
directory for review rather than broad-cleaning it. The local kill switch is
therefore process termination; there is no live activation to disable.

Rollback means retaining the immutable v3 receipt and stopping the local gate;
no production or remote state was changed. Do not delete, rerun, or overwrite
the v1/v2 helpers, their sealed outputs, or their archives. This handoff proves
byte and semantic seal integrity, metadata joins, partition nesting, and
privacy/holdout boundaries only. It does not prove same-request eligibility, a
runnable holdout, live runtime authority,
PMS-positive preparation, model quality, mail delivery, login authentication,
or remote activation. Remote live enablement remains unknown; the diagnosed
installed `asm-exec` pin mismatch is a separate read-authority limitation.

### Exact proof commands

Run from this worktree. Before each new browser run, copy the complete
`u11a-browser-artifacts/` directory to a new private archive; never overwrite a
prior archive.

```bash
# Gate-dispatch/unit contract (unit:integration is intentionally unknown;
# db:integration is the executable DB mapping).
env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=test CI=1 \
  AWS_EC2_METADATA_DISABLED=1 \
  bash apps/server-pilot/scripts/reservation-pilot-gate.sh unit gate

# One-time private v3 pre-outcome publication; metadata-only, no model or target
# body. The sealed run ID intentionally refuses to overwrite an existing run.
env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=test CI=1 \
  AWS_EC2_METADATA_DISABLED=1 \
  node .private/centurion-dashboard-tools-execution/u11-private-qualification-v3.mjs \
  build u11-v3-20260910-r2

# Read-only verification; recomputes the pinned input digest-set, semantic
# cross-file contract, and output hashes. Use a new unique run ID for any
# future build; never reuse the sealed ID above.
env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=test CI=1 \
  AWS_EC2_METADATA_DISABLED=1 \
  node .private/centurion-dashboard-tools-execution/u11-private-qualification-v3.mjs \
  verify u11-v3-20260910-r2

# Sole DB runner; use the literal owned PG16 wrapper and no direct Vitest.
sudo -n bash -c 'set -a; source /home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-dashboard-tools-execution/pg16/disposable-postgres-connection.env; set +a; NAVA_TEST_DATABASE_PROFILE=pg16 CONFIRM_DISPOSABLE_TEST_DB=1 bash /home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/apps/server-pilot/scripts/reservation-pilot-gate.sh db integration'

# Read-only current-readiness checks; do not substitute promote/rollback/read.
codegraph status --json "$PWD"
env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=test CI=1 \
  AWS_EC2_METADATA_DISABLED=1 \
  bash apps/server-pilot/deploy/ops-hms-proof.sh --help
env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=test CI=1 \
  AWS_EC2_METADATA_DISABLED=1 \
  bash apps/server-pilot/deploy/ops-hms-proof.sh doctor --offline --json
env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=test CI=1 \
  AWS_EC2_METADATA_DISABLED=1 \
  bash apps/server-pilot/deploy/ops-hms-proof.sh status --json
# Remote doctor is a read-only bootstrap check; record exit 70/TRANSPORT_UNCERTAIN
# if the wrapper returns it. After an exit 70, reconcile only metadata for the
# already-issued command and use the bounded diagnostics below; this handoff
# performs no repair or retry and never authorizes live operations.
AWS_EC2_METADATA_DISABLED=1 \
  bash apps/server-pilot/deploy/ops-hms-proof.sh doctor \
  --tool hms_find_reservation --action read-discovery --json

# Bounded nonmutating cause diagnostics; emit only sanitized states.
bash -n apps/server-pilot/deploy/ssm-run-command.sh
command -v aws
AWS_EC2_METADATA_DISABLED=1 AWS_PAGER='' \
  aws sts get-caller-identity >/dev/null 2>&1
SSM_SCRIPT=apps/server-pilot/deploy/ssm-run-command.sh
INSTANCE_ID="$(sed -n 's/^: "${INSTANCE_ID:=\([^\"]*\)}".*/\1/p' "$SSM_SCRIPT")"
SSM_COUNT="$(AWS_EC2_METADATA_DISABLED=1 AWS_PAGER='' \
  aws ssm describe-instance-information --region af-south-1 \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --query 'length(InstanceInformationList)' --output text 2>/dev/null)"
case "$SSM_COUNT" in
  0) echo 'SSM_TARGET_DISCOVERY=target-not-discovered' ;;
  ''|*[!0-9]*) echo 'SSM_TARGET_DISCOVERY=unavailable-or-unexpected' ;;
  *) echo 'SSM_TARGET_DISCOVERY=target-present' ;;
esac

# Browser gates (loopback-only Chromium namespace; archive output before each).
env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=test CI=1 \
  AWS_EC2_METADATA_DISABLED=1 \
  bash apps/server-pilot/scripts/reservation-pilot-gate.sh browser dashboard
env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=test CI=1 \
  AWS_EC2_METADATA_DISABLED=1 \
  bash apps/server-pilot/scripts/reservation-pilot-gate.sh browser documents
env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=test CI=1 \
  AWS_EC2_METADATA_DISABLED=1 \
  bash apps/server-pilot/scripts/reservation-pilot-gate.sh browser pilot

# Builds and changed-path lint/syntax checks.
env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=test CI=1 \
  AWS_EC2_METADATA_DISABLED=1 \
  bash apps/server-pilot/scripts/reservation-pilot-gate.sh build server
env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=test CI=1 \
  AWS_EC2_METADATA_DISABLED=1 \
  bash apps/server-pilot/scripts/reservation-pilot-gate.sh build mail
node_modules/.pnpm/oxlint@1.6.0/node_modules/oxlint/bin/oxlint --deny-warnings \
  apps/server-pilot/tests/reservation-tools-pilot-integration.test.ts \
  apps/server-pilot/tests/reservation-pilot-gate-dispatch.test.ts \
  apps/server-pilot/scripts/reservation-pilot-gate-lib.mjs
bash -n apps/server-pilot/scripts/reservation-pilot-gate.sh
git diff --check

# Final post-format-only checks (no new application gates in this handoff).
node_modules/.bin/prettier --check \
  apps/server-pilot/tests/reservation-tools-pilot-integration.test.ts \
  docs/infor-hms/dashboard-tools-pilot-runbook.md
git diff --check
```

### Exact receipts and artifact locations

- Worker receipt and path map: `.private/centurion-dashboard-tools-execution/u11-final-report.md` (final `wc -l`: 250; report line-count receipt recorded at closure).
- Third-repair writer unit receipt: the exact `bash apps/server-pilot/scripts/reservation-pilot-gate.sh unit gate` returned `PASS` and printed `/tmp/reservation-pilot-vitest.OV9Z5s.json` (the wrapper's transient report was consumed/removed after validation). The preserved causal RED is `/tmp/reservation-pilot-vitest.UQZKbc.json`; no root transient numeric receipt is attributed here.
- DB proof: `reservation-pilot-gate: PASS mode=db slice=integration`; transient JSON is intentionally removed by the gate after the nonempty/non-skipped check.
- Root post-format receipts are distinct from the writer's pre-format gates: unit gate `Dtpmdt` PASS, `db:integration` `tmNbq1` PASS, and post-format static checks PASS. The earlier writer browser/build receipts remain pre-format evidence; no repeat browser/build/DB run is claimed here.
- Browser dashboard archive (2 selected tests): `.private/centurion-dashboard-tools-execution/u11a-browser-archive-20260910T022555Z-u11-dashboard-pass/` (desktop/mobile screenshots, traces, videos, completion captures).
- Browser documents archive (1 selected test): `.private/centurion-dashboard-tools-execution/u11a-browser-archive-20260910T022515Z-u11-documents-pass/`.
- Browser pilot archive (1 selected test): `.private/centurion-dashboard-tools-execution/u11a-browser-archive-20260910T022453Z-u11-pilot-pass/`; pre-run output: `.private/centurion-dashboard-tools-execution/u11a-browser-archive-20260910T022307Z-u11-integrated/`.
- Accepted boundaries: `.private/centurion-dashboard-tools-execution/u6-third-repair-review.md`, `.private/centurion-dashboard-tools-execution/u13-status-filter-review.md`, and `.private/centurion-dashboard-tools-execution/u5-advisory-review.md`. The superseded `u13-coverage-review.md` and `u5-advisory-repair-report.md` remain historical only.
- Synthetic disposition source: `apps/server-pilot/tests/fixtures/reservation-tools-pilot.json` (`420/253/251`, `eligibleGoldCases=0`).
- Private v3 qualification: `.private/centurion-dashboard-tools-execution/u11-private-qualification-v3/u11-v3-20260910-r2/{manifest.json,aggregate.json,receipt.json,seal.json}`; these contain hashed IDs, pinned source-pointer metadata, historical-replay mode, per-case reference/time/direction states, semantic counts, and byte hashes only. The sealed input digest-set is `sha256:0f5c581b2fa9db1b4de66323e0ed3f3a02ddf7cdb2e5c3a312ff4f0390f4b5f2`; verify-only recomputation passes. The intermediate v3 `r1`, superseded v2 `r2`, and historical v1 paths remain preserved in their named directories and `u11r2-private-freeze.ZZZWSZ`/`u11r1-private-freeze.I5cDLp` archives.
- v3 immutable byte receipt (strict same-thread final): `manifest.json` `907657` bytes `sha256:3b0113178c70f1cf8fd98f0297cb17420ba710f23cf867daff0a31b7cc31b4b1`; `aggregate.json` `1815` bytes `sha256:12bef7815119950a4f92b93dc3f2f4a97610a6a2f68aff9d26b99e05b54fe909`; `receipt.json` `4107` bytes `sha256:747ee371b5a3740522fdbdbb2c1cdca34ad7933dff5fb8d528acff1d48ebb210`; `seal.json` `3694` bytes `sha256:aabf4e3e972996f9ce5ef6d8bfa6662c9b9d7d2159bca2725df40a9e30539a7a`. The manifest digest is `sha256:3b0113178c70f1cf8fd98f0297cb17420ba710f23cf867daff0a31b7cc31b4b1`; the exact read-only verifier is the v3 `verify u11-v3-20260910-r2` command above.

### Artifact ownership, access, and retention

| Artifact family                                                             | Owner and scope                                                      | Privacy / fetch rule                                                                                                                                                                                                                                                       | Retention and expiry                                                                                                                                                                |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard/documents/pilot screenshots, traces, videos, and `.last-run.json` | Dashboard owner; private U11 reviewer/operator scope only.           | Fetch from the named private archive paths; do not copy cookies, response bodies, mailbox content, or credentials. Raw media fetch requires the existing `--confirm-sensitive` operator control.                                                                           | Existing browser/archive expiry applies; raw capture is subject to the operator runbook's short retention (24h for raw media). This checkout does not enforce local TTLs.           |
| Unit/DB/build/static gate receipts                                          | Read-only toolkit owner; private reviewer scope.                     | Gate JSON is transient and consumed by the wrapper; retain only sanitized report counts and exact command/exit receipts. Never export DB URLs, rows, or raw fixture payloads.                                                                                              | Transient JSON is removed by the gate after validation; retained reports follow the private evidence policy. No local expiry job is asserted.                                       |
| Private qualification manifest, aggregate, receipt, and seal                | Read-only toolkit/U1 qualification owner; private reviewer scope.    | Fetch only the four named v3 private paths. They contain hashed IDs, pinned source-pointer metadata, counts, hashes, mode/ref/time/direction states, and semantic seal fields; no raw record, gold/target body, or target-only reference is fetched into tool/model input. | Proposed evaluation retention is 30 days after sealing, subject to policy; this checkout has no expiry enforcement. Preserve the sealed receipt until independent review completes. |
| Phase B read operation receipts/artifacts                                   | Phase B read operator; authorized read-only operator/reviewer scope. | Use `status`, `artifacts --latest-usable`, and `fetch-artifact <uuid> receipt`; trace/video fetch requires `--confirm-sensitive`. Do not fetch raw media into reports.                                                                                                     | Existing artifact controls and expiry apply; raw capture is 24h in the operator contract. Missing local proof is reported, not replaced.                                            |
| Accepted U6/U13 and parked-U5 reviews                                       | Drafting/release owner; private reviewer scope.                      | Link the final U6/U13 and independent parked-U5 reports only; superseded reports are historical. No source corpus or credentials are copied.                                                                                                                               | Preserve immutable review receipts for the handoff; no local deletion or TTL enforcement is claimed.                                                                                |

The owner labels are handoff ownership, not new permissions. All current
authorized application users retain their configured tools/data; a private
scope or expiry statement does not establish live activation or external
authority.

### Launch floors and release disposition

The proposed release slice stays shadow-only unless every floor below is
independently evidenced. These are operating floors, not a statistical accuracy
claim:

- Zero critical fixture escapes.
- At least 30 fresh eligible request runs across the proposed slice, with at
  least five per released family, sampled before generation outcomes are known.
- At least 90% useful supported complete or correctly-partial outcomes overall
  and within every released family; failed generation and missing output are
  not useful, and unscorable/denied/unknown/changed/not-runnable cases never
  enter the success numerator.
- Zero critical recipient, action, or fact errors.
- The 25/25 good-family plus 2/5 weak-family pooled 90% case does not promote
  the weak family. If independent review is unavailable, remain shadow-only.
- Historical replay, current-state, and future-shadow modes stay separate.
  The independent inbound-first holdout is sampled without conditioning on a
  reply and excludes target/future context; a held-out outcome cannot tune,
  repair, choose a fixture, or trigger a retry. Once exposed, it retires to
  development/regression while preserving the original outcome and exposure.

The v3 private qualification freezes 581 map members (420/253/251 distinctions
retained), with 440 unique fingerprint joins, 92 independently verified source
threads, 489 unresolved/unassigned cases, 92 unscorable cases, 489
not-runnable cases, and zero runnable cases. Its metadata-only prereply
classification records 72 strict earlier same-thread context candidates,
zero pinned prereply-reference matches, 60 wrong-direction joins, 20
reference-not-in-prereply joins, 12 missing-context inbound joins, and 489
source-direction-missing unresolved rows. These are qualification states, not
outcome results. The v3 source is explicitly historical-replay; current-state
and future-shadow aggregation is rejected. It therefore satisfies none of the
fresh-run/family floors and does not establish real eligibility or Phase 2/B
readiness. Only verified threads were assigned to development; no historical
holdout membership was established, while unresolved rows remain unassigned.
The later inbound-first `targetEpisodes >= 200` floor is a separate future
holdout requirement, not a condition on historical development membership. The
synthetic fixture's `eligibleGoldCases=0` remains a synthetic contract value,
not the real-corpus result. The earlier v1/v2 receipts are historical and
superseded, not reused as evidence.

### Current readiness / Phase 2B read-only audit

The fixture gates do not establish current operational readiness. The existing
operator entry points were inspected at
`apps/server-pilot/deploy/ops-hms-proof.sh` and
`docs/infor-hms/phase-b-read-portfolio-operator-runbook.md`; only their help,
offline doctor, status, one bounded read-only remote doctor check, three
sanitized transport diagnostics, and metadata reconciliation of that already
issued SSM command were used. No live capability read/proof, promote, rollback,
browser, model, PMS, mail, or registry mutation action was run.

| Check                   | Receipt                                                                                                                                                                                                                                                                                                                                                                      | Meaning                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CodeGraph freshness     | `codegraph status --json "$PWD"`: current worktree, complete index, pending `0/0/0`, `reindexRecommended=false`.                                                                                                                                                                                                                                                             | Static lookup freshness only.                                                                                                                                                                                                                |
| Local operator doctor   | `ops-hms-proof.sh doctor --offline --json`: exit `0`, `liveReady=false`, active tools `[]`, `registryLoadState=missing`, no live-proof digests/active releases.                                                                                                                                                                                                              | Local contract snapshot; fixture rows are not current external capability.                                                                                                                                                                   |
| Local operator status   | `ops-hms-proof.sh status --json`: exit `0`, `STATUS_OK`, active tools `[]`, `registryLoadState=missing`; all `liveProofDigestPresent=false`.                                                                                                                                                                                                                                 | Missing laptop registry is missing local evidence, not proof of a live wipe.                                                                                                                                                                 |
| Explicit runtime paths  | `/opt/nava/shared/hms-active-registry/active.json`, `/opt/nava/shared/hms-browser-artifacts/index.v1.json`, `/opt/nava/shared/hms-runtime/hms-reservation-canary-proof.v1.json`, `/opt/nava/shared/hms-runtime/phase-b-operations`, `/opt/nava/shared/hms-releases`, `/etc/nava/hms-read-role-proof.v1.json`, and `/etc/nava/hms-evidence-hmac.env` were all absent locally. | Current local registry/role/capture/release proof is unavailable; contents were not read.                                                                                                                                                    |
| Remote read-only doctor | Wrapper exit `70` (`TRANSPORT_UNCERTAIN`); reconciled metadata for the already-issued command was terminal `Failed`, `ResponseCode=1`, with an online Linux target, active `AWS-RunShellScript`, vendor `asm-exec` pin `OK`, and installed `/usr/local/bin/asm-exec` pin `FAILED`.                                                                                           | The remote command reached the target and stopped at the installed-binary pin check; this is not a credential/transport outage. Remote registry/role/source/release/capture proof remains unassessed, and remote live enablement is unknown. |

The current process exposed no HMS/AI/registry/release/capture variable names
(only AWS config-file variable names; values were not read). The preserved U11
browser archive `.last-run.json` files report `status=passed` and
`failedTests=0`, but remain loopback fixture evidence.

#### Bounded transport-cause diagnostics

The exit-70 wrapper result was followed by exactly three nonmutating checks,
with no IDs, account values, credentials, raw configuration, or command
payloads emitted. The already-issued SSM command was then reconciled through
metadata-only CloudTrail and `get-command-invocation` queries; this was not a
new doctor attempt:

1. `bash -n apps/server-pilot/deploy/ssm-run-command.sh` passed and
   `command -v aws` reported the AWS CLI available.
2. `AWS_EC2_METADATA_DISABLED=1 AWS_PAGER='' aws sts get-caller-identity`
   returned exit `0`; the identity/account response was discarded.
3. `AWS_EC2_METADATA_DISABLED=1 AWS_PAGER='' aws ssm
describe-instance-information --region af-south-1` queried only the
   wrapper-configured target and returned exit `0` with a positive target
   presence state; the target identifier and count were discarded.

These checks distinguish the wrapper outcome from its cause: the local path
reached AWS, the configured target was online, and the issued command ran but
failed its installed `/usr/local/bin/asm-exec` hash check against the vendor
pin. The existing doctor check is at `ops-hms-proof.sh` lines 129-132; the
wrapper maps this nonzero terminal response to exit `70` at
`ssm-run-command.sh` lines 111-135. No missing-path or permission marker and no
`DOCTOR_EVIDENCE_BOOTSTRAP_OK` sentinel were present. The bounded disposition
is one doctor attempt, three diagnostics, and one metadata reconciliation in
this session; no binary repair or retry was made. This checkout has no live
activation; remote live enablement remains unknown, not proved disabled.

#### Private corpus metadata boundary

The map's existing `.sources[].file` pointers were followed with `stat` and
metadata-only `jq`; all 14 pointer files are regular files:
`.private/both-outbound-emails-gold/indexes/catchup-all.json`,
`.private/both-outbound-emails-gold/indexes/gold-response-tool-analysis-2026-09-04.json`,
`.private/both-outbound-emails-gold/indexes/union-gold.json`,
`.private/connected-mailbox-corpus-pdf/live-de3bd118-31d8-4397-a384-911ae285d764-ycThvI/corpus.jsonl`,
`.private/connected-mailbox-corpus/connected-mailbox-inbox-2026-09-01-eod.md`,
`.private/gold-product-research-2026-09-06/addendum-summary.json`,
`.private/gold-product-research-2026-09-06/annotations-addendum-combined.json`,
`.private/gold-product-research-2026-09-06/annotations-combined.json`,
`.private/gold-product-research-2026-09-06/count-audit.json`,
`.private/gold-product-research-2026-09-06/coverage-gap-audit.md`,
`.private/gold-product-research-2026-09-06/prior-evidence-audit.md`,
`.private/gold-product-research-2026-09-06/review-extra-platform.json`,
`.private/gold-product-research-2026-09-06/review-records.json`, and
`.private/gold-product-research-2026-09-06/review-summary.json`. The public
`.private/pms-tools-replan-2026-09-07/docs-public/manifest.json` has 53 HTTPS
source receipts, each status `200`, fetched-at metadata, and a 64-character
SHA-256; it is a public-source receipt, not a local record-linkage manifest.

Metadata-only inspection found 581 map records with 581 unique IDs, the
`original_420` cohort and the preserved 253/251 canonical distinctions. The
474 review rows have source-message IDs and ISO-shaped sent timestamps; 126
also have source-thread IDs and 333 carry nonempty pre-reply context with
message/thread/direction/sent fields. The 107 platform rows have source
thread/message/sent/as-of fields but no pre-reply context. The connected-mailbox
snapshot has one metadata row, 2,987 thread rows, and 4,047 messages with
thread/message IDs, timestamps, scope membership, and content fingerprints.
Its UUID-shaped source-row IDs did not directly match the review pointer IDs,
so it was not used to invent a source binding. The bounded independent join
instead used map record ID → review/platform pointer metadata and pointer `fp`
→ union/catch-up `fp`: 454 candidate joins, 440 unique joins after duplicate
tuple removal, and 92 matching opaque source message+thread bindings. No body
hash or gold/target body was parsed for tool input; RFC-reference matching was
reported separately as zero. The aggregate still reports zero runnable
outcomes/full reply input sets.

The initial bounded pass did not open the map records array or any gold/target
body; the later qualification passes parsed only metadata fields (keys, counts,
hashes, timestamps, direction, and linkage) from the bounded source rows and
the pinned map. The new deterministic private qualification helper
`.private/centurion-dashboard-tools-execution/u11-private-qualification-v3.mjs`
then emitted the immutable v3 pre-outcome manifest/aggregate/receipt/seal from
those bounded fields. Explicit existence checks for the bounded named paths
`phase2b-manifest.json`, `phase2b-corpus-manifest.json`,
`eligibility-manifest.json`, `holdout-freeze.json`, and `selection-freeze.json`
were absent. The v3 helper instead froze 581 hashed members, historical-replay
mode, independently supported development conversation assignments, unresolved
unassigned cases, explicit per-case reference/time/direction reasons,
mapping/selection hashes, evaluator-only target exposure, and blocked outcome
semantics before outcomes. It recorded 440 unique fingerprint joins, 92
verified source threads, 489 unresolved/unassigned cases, 489 not-runnable, 92
unscorable, and zero runnable cases; no historical holdout membership was
established. The 200-episode inbound-first target is a separate future holdout
floor with zero selected runnable episodes. This is a partial local
qualification receipt, not an external blocker and not evidence that the real
corpus is ineligible. It is
not inferred from the synthetic `eligibleGoldCases=0`.

#### Phase 2B truth boundary

The public manifest's synthetic `eligibleGoldCases=0` is not the eligibility
result for the real 420 selected records. Its own contract records synthetic
freeze/hash/held-out safeguards only. The v3 private receipt establishes
pre-outcome membership, hashed case IDs, independently supported development
conversation assignments, unresolved unassigned cases, skip reasons, and
selection/mapping hashes for the 581-row canonical map, while pinned
pre-reply reference/horizon evidence, runnable eligibility, and current audited
capability remain unproven. User access is already settled by the owner;
these are source/runtime proof gaps, not denied pilot-user permissions.
No historical holdout membership, real corpus outcome, current
capability, live release, or Phase 2/B readiness claim is made. Accepted normal
paths remain linked rather
than duplicated: U9's actual document producer →
queue/worker → authorized service DB receipts are in
`.private/centurion-dashboard-tools-execution/u9-backend-review.md` (review
range `87920e22..2a2fde12`); U6's configured worker/approval/outbox receipts at
source `f8fdd2f41a5c3e79c636abf906ff8c1a2328964d` are in
`.private/centurion-dashboard-tools-execution/u6-third-repair-review.md`; and
U13's local-synthetic normal producer/worker/dashboard receipts at source
`ee01228d4ffa3e36ce1fdf975578d3af2e9b0e89` are in
`.private/centurion-dashboard-tools-execution/u13-status-filter-review.md`.
U5 PMS-to-prepared remains PARKED LOCAL/advisory-used.

The sanitized public-fixture metadata check does confirm that the fixture's own
membership/case/evaluation/selection freezes, mode-specific aggregation,
evaluator-only target exposure, mapping hash, and selection hash fields are
present. Those are synthetic-contract safeguards only; they are not the real
420-record eligibility, horizon, skip, membership, or held-out result.

This handoff therefore records partial local integration and a bounded offline
metadata diagnosis, not a complete current/live Phase 2/B proof or a joined AI
draft/approval/send journey. U5 remains PARKED LOCAL/advisory-used, and accepted
U6/U13 evidence remains separate.

### Final third-repair edit inventory

The final bounded third-repair tracked edit inventory is exactly:

1. `apps/server-pilot/scripts/reservation-pilot-gate-lib.mjs`
2. `apps/server-pilot/tests/reservation-pilot-gate-dispatch.test.ts`
3. `docs/infor-hms/dashboard-tools-pilot-runbook.md`

The private v3 helper and sealed run are ignored evidence, not tracked branch
edits; the earlier five-path integrated U11 inventory, accepted U6/U13 source
paths, and frozen v1/v2 artifacts remain unchanged.

### Kill switch and rollback

1. Stop the browser gate/local Vite/Chromium process; no persistent runtime is
   created by this handoff.
2. Before any live consideration, inspect the exact current read state and
   latest receipt without mutating it:

   ```bash
   for tool_id in hms_find_reservation mail_read_artifact hms_quote_stay \
     hms_sent_email_audit hms_list_documents hms_read_folio; do
     bash apps/server-pilot/deploy/ops-hms-proof.sh status \
       --tool "$tool_id" --json || exit $?
   done
   bash apps/server-pilot/deploy/ops-hms-proof.sh artifacts \
     hms_find_reservation --latest-usable --json
   ```

   The `status`/`artifacts` commands are read-only. Do not treat a missing
   local registry or an unknown remote state as a successful rollback.

3. After an approved quiesce and authoritative receipt reconciliation, use the
   existing Phase B rollback grammar for each affected tool; no new command or
   release ID is invented:

   ```bash
   bash apps/server-pilot/deploy/ops-hms-proof.sh read-rollback \
     <tool-id> --json
   rollback_exit=$?
   case "$rollback_exit" in
     0)  ;; # COMPLETE / NOOP_ALREADY_APPLIED / NEXT_ACTION_READY
     2)  echo 'USAGE_ERROR: repair the command; do not retry blindly' >&2; exit 2 ;;
     3)  echo 'AGENT_OR_EXTERNAL_BLOCK: follow the returned next action' >&2; exit 3 ;;
     10) echo 'POLICY_OR_EVIDENCE_REJECTED: stop and preserve evidence' >&2; exit 10 ;;
     20) echo 'ROLLBACK_INCOMPLETE: halt; do not promote or resend' >&2; exit 20 ;;
     70) echo 'TRANSPORT_UNCERTAIN: reconcile the same operation metadata only' >&2; exit 70 ;;
     *)  echo "unexpected rollback exit=$rollback_exit; halt" >&2; exit 1 ;;
   esac
   ```

   `read-wave <subwave-id> --json`, `status --operation <operation-id> --json`,
   `artifacts <tool-id> --operation <operation-id> --json`, and
   `fetch-artifact <uuid> receipt` are the existing operation/receipt links.
   `read-rollback` remains unavailable for this handoff while remote state is
   unknown; it was not executed.

4. For unsent AI work, the existing approval-aware candidate procedure is
   `node apps/server-pilot/scripts/supersede-centurion-ai-runs.mjs` (dry-run by
   default), followed only by its explicitly controlled `--apply --reason
"<reason>"` form after quiesce, snapshot, and owner approval. The script
   scopes `transport-centurion` to `inbound_triage` and `candidate_draft` in
   `queued|claimed|running|retry_wait`; it is not a read-job rollback command.
   Poll its existing key-prefix drain with
   `node apps/server-pilot/scripts/poll-quality-retag-status.mjs <key-prefix>`.
   Preserve receipts and unknown states; do not retry or resend from an
   ambiguous SMTP result.
5. Drain, cancel, or quarantine pending read jobs only through the existing
   read-wave/worker owner procedure after it reports the operation ID. Keep
   human manual mail available; do not convert a manual path into an
   autonomous sender.
6. Roll back only after pending rows, receipts, and provider-attempt state are
   reconciled. Restore the last reviewed worker/release descriptor; do not
   reinterpret old workers as understanding a new `read_tool` contract.

No production activation, business write, migration, shared-service mutation,
or external email send occurred in this handoff, so there is no live state to
undo.

### Limitations and owner assumptions

- All current authenticated application users have all configured tools/data,
  including finance and Research. This is the owner's access assumption to
  double-check at handoff, not a pending approval or a new role gate.
  Authentication, configured source/property/ref binding, read-only PMS
  boundaries, and human approval/send remain authoritative.
- Browser proof is a loopback fake transport, separate from server/DB/outbox
  proof. The document DB test constructs its admission context rather than
  performing a browser login; the mail case uses an injected session user
  through the real route/queue path, not a login-authentication proof.
- U6 is local accepted proof only (`f8fdd2f4`, PASS/PASS with zero Important
  findings at its final line 171). U13 is local synthetic only (`ee01228d`).
  U5 I3 is incomplete and PARKED LOCAL/advisory-used; no PMS-to-prepared
  positive was fabricated or bypassed.
- The public fixture is synthetic and has zero eligible gold cases. Historical
  replay, future shadow, and current state remain mode-separated. No corpus
  fixture, private data, inaccessible evidence, live model/PMS result, or
  Phase 2/B readiness status is promoted by this runbook. The private receipt
  freezes hashed map membership, mode/split, skip reasons, hashes, and
  evaluator-only exposure before outcomes, but records zero runnable cases:
  no pinned pre-reply reference match is established, and unresolved
  source/direction linkages remain. Current live audited capability is also
  unproven, separately from user access. These are evidence limitations, not
  missing pilot-user permission or a full U11/Phase 2/B completion claim.
  The diagnosed installed `asm-exec` pin
  mismatch is a runtime-capability unknown/block, not a user-access denial and
  not an explanation for missing source or horizon facts.
