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

## U11 final integrated handoff (2026-09-10)

Disposition: local proof only. The integrated DB slice reuses existing
server-pilot admission, read, document, shadow, mailbox-context-authorized mail, and queue
components. It does not enable a live model/PMS route, promote fixtures, or
join browser output to a production server session.

### Three-phase owner check

Owner check: the Dashboard owner owns the read-only surface, the Read-only
toolkit owner owns the integrated read boundaries, and the Drafting agent owner
owns assistance/release disposition. Each owner preserves the named evidence
scope and cannot promote a later phase from a lower-phase fixture receipt.

| Phase                    | Owner check                                                                                                                                                                               | Implemented                                                                                                   | Locally verified / current proof                                                                                                                                                            | Live enablement                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Read-only surface     | Dashboard owner confirms dashboard cutoff/cohort and document receipts remain source-bound and manual when evidence is unavailable.                                                       | Existing dashboard/document UI, read admission, document service, and loopback fixture.                       | `browser dashboard` (desktop + mobile) and `browser documents`; model-free document DB slice.                                                                                               | Not enabled; browser transport is loopback-only and synthetic.                                                                                                                        |
| 2. Integrated boundaries | Read-only toolkit owner confirms read receipts, causal shadow separation, and mailbox-context mail send/queue receipts before any release decision.                                       | `apps/server-pilot/tests/reservation-tools-pilot-integration.test.ts`; exact `db:integration` gate.           | Three DB cases pass on owned disposable PG16: model-free document/manual fallback, private future-shadow matching/scorecard, and injected-session `mail.send` → outbound queue → fake SMTP. | Not enabled; the SMTP edge, document bytes, shadow model/labels, and seeded rows are synthetic/local.                                                                                 |
| 3. Assistance/release    | Drafting agent owner requires accepted normal worker + approval/current-authority evidence and resolves parked PMS-to-prepared work before claiming an AI journey or Phase 2/B readiness. | Accepted U6 local worker/approval evidence and existing browser pilot remain separate; U13 is synthetic-only. | `browser pilot` and retained U6 receipts; no new joined browser/server proof in U11. U5 I3 remains PARKED LOCAL/advisory-used.                                                              | No live enablement proved; this checkout has no live activation and remote state is unknown. No live model, PMS, production outbox, autonomous sender, or Phase 2/B capability claim. |

### Path and proof boundaries

| Journey                | Actual path                                                                                                                                                                              | Seeded/direct lower edge                                                                                      | Claim allowed                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard              | Fixture-session UI/provider → `adminDashboard` reads.                                                                                                                                    | Vite loopback fixture; no DB/outbox.                                                                          | Desktop/mobile UI and transport contract only; no login-authentication claim.                                                                               |
| Documents              | `issueReadAdmission` → `executeReadToolRun` → `createExistingDocumentService` → authorized artifact reader.                                                                              | Constructed test admission/context and `FakeS3Storage`; existing browser UI uses its own fixture HTTP bridge. | Typed model-free read and `SOURCE_UNAVAILABLE`/`manual_required`; no PMS-positive or draft claim.                                                           |
| Shadow                 | `freezeShadowInput` → seal → later-thread matcher → mode-specific scorecard.                                                                                                             | Direct production pure functions with synthetic in-process route/model/label.                                 | Causal nondisplay and mode separation; U13 local synthetic only.                                                                                            |
| Mail-only manual send  | Seeded thread/inbound message → `callerFor('user-navaai')` with injected session user and no login transport → actual `caller.mail.send` → message/outbound queue → `FakeSmtpTransport`. | Owned disposable PG16 and fake SMTP; `UNDO_SEND_SECONDS=0` is scoped/restored.                                | Mailbox-context authorization plus the real route/queue boundary only; it is not login authentication and not the supported AI draft/approval/send journey. |
| AI draft/approval/send | Accepted U6 configured worker/factory/caller and approval/send receipts; separate browser fixture pilot.                                                                                 | Lower synthetic model/SMTP in accepted U6 receipts.                                                           | U6 local-only evidence; never call it a joined browser-to-production proof.                                                                                 |
| PMS/manual             | Existing source-unavailable/manual surface.                                                                                                                                              | No PMS-positive fixture.                                                                                      | U5 PMS-to-prepared positive remains incomplete and parked.                                                                                                  |

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

# Private pre-outcome qualification/freeze; metadata-only, no model or target body.
env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=test CI=1 \
  AWS_EC2_METADATA_DISABLED=1 \
  node .private/centurion-dashboard-tools-execution/u11-private-qualification.mjs

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
- DB proof: `reservation-pilot-gate: PASS mode=db slice=integration`; transient JSON is intentionally removed by the gate after the nonempty/non-skipped check.
- Root post-format receipts are distinct from the writer's pre-format gates: unit gate `Dtpmdt` PASS, `db:integration` `tmNbq1` PASS, and post-format static checks PASS. The earlier writer browser/build receipts remain pre-format evidence; no repeat browser/build/DB run is claimed here.
- Browser dashboard archive (2 selected tests): `.private/centurion-dashboard-tools-execution/u11a-browser-archive-20260910T022555Z-u11-dashboard-pass/` (desktop/mobile screenshots, traces, videos, completion captures).
- Browser documents archive (1 selected test): `.private/centurion-dashboard-tools-execution/u11a-browser-archive-20260910T022515Z-u11-documents-pass/`.
- Browser pilot archive (1 selected test): `.private/centurion-dashboard-tools-execution/u11a-browser-archive-20260910T022453Z-u11-pilot-pass/`; pre-run output: `.private/centurion-dashboard-tools-execution/u11a-browser-archive-20260910T022307Z-u11-integrated/`.
- Accepted boundaries: `.private/centurion-dashboard-tools-execution/u6-third-repair-review.md`, `.private/centurion-dashboard-tools-execution/u13-status-filter-review.md`, and `.private/centurion-dashboard-tools-execution/u5-advisory-review.md`. The superseded `u13-coverage-review.md` and `u5-advisory-repair-report.md` remain historical only.
- Synthetic disposition source: `apps/server-pilot/tests/fixtures/reservation-tools-pilot.json` (`420/253/251`, `eligibleGoldCases=0`).
- Private pre-outcome qualification: `.private/centurion-dashboard-tools-execution/u11-private-qualification/manifest.json`, `aggregate.json`, and `receipt.json`; these contain hashed IDs and field/count metadata only. Receipt digests are `contentHash=sha256:10023ce3b51f9b999614b4ceeeec3f12e36dac39c1ac48f145258520bf98f271`, `mappingHash=sha256:422232120b8e7eba91ca33fd0d18808547c927413d29d1fc2be853188dba13bb`, and `selectionHash=sha256:e42fde4a37d1ad77389ea07193e72baf52382c08892deecbc0be002886e860a8`.

### Artifact ownership, access, and retention

| Artifact family                                                             | Owner and scope                                                      | Privacy / fetch rule                                                                                                                                                                                                       | Retention and expiry                                                                                                                                                                |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard/documents/pilot screenshots, traces, videos, and `.last-run.json` | Dashboard owner; private U11 reviewer/operator scope only.           | Fetch from the named private archive paths; do not copy cookies, response bodies, mailbox content, or credentials. Raw media fetch requires the existing `--confirm-sensitive` operator control.                           | Existing browser/archive expiry applies; raw capture is subject to the operator runbook's short retention (24h for raw media). This checkout does not enforce local TTLs.           |
| Unit/DB/build/static gate receipts                                          | Read-only toolkit owner; private reviewer scope.                     | Gate JSON is transient and consumed by the wrapper; retain only sanitized report counts and exact command/exit receipts. Never export DB URLs, rows, or raw fixture payloads.                                              | Transient JSON is removed by the gate after validation; retained reports follow the private evidence policy. No local expiry job is asserted.                                       |
| Private qualification manifest, aggregate, and receipt                      | Read-only toolkit/U1 qualification owner; private reviewer scope.    | Fetch only the three named private paths. They contain hashed IDs, source-pointer metadata, counts, hashes, and field reasons; no raw record, gold/target body, or target-only reference is fetched into tool/model input. | Proposed evaluation retention is 30 days after sealing, subject to policy; this checkout has no expiry enforcement. Preserve the sealed receipt until independent review completes. |
| Phase B read operation receipts/artifacts                                   | Phase B read operator; authorized read-only operator/reviewer scope. | Use `status`, `artifacts --latest-usable`, and `fetch-artifact <uuid> receipt`; trace/video fetch requires `--confirm-sensitive`. Do not fetch raw media into reports.                                                     | Existing artifact controls and expiry apply; raw capture is 24h in the operator contract. Missing local proof is reported, not replaced.                                            |
| Accepted U6/U13 and parked-U5 reviews                                       | Drafting/release owner; private reviewer scope.                      | Link the final U6/U13 and independent parked-U5 reports only; superseded reports are historical. No source corpus or credentials are copied.                                                                               | Preserve immutable review receipts for the handoff; no local deletion or TTL enforcement is claimed.                                                                                |

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

Current private qualification has 581 frozen map members (420/253/251
distinctions retained), 579 not-runnable cases, 2 unscorable cases, and zero
runnable cases. It therefore satisfies none of the fresh-run/family floors and
does not establish real eligibility or Phase 2/B readiness. The synthetic
fixture's `eligibleGoldCases=0` remains a synthetic contract value, not the
real-corpus result.

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
No exact map-ID or body-hash join was found against that snapshot or the
outbound-gold indexes. The aggregate validation still reports zero verified
independent execution outcomes and zero verified full reply input sets.

The initial bounded pass did not open the map records array or any gold/target
body; the later pass parsed only metadata fields (keys, counts, hashes,
timestamps, and linkage) from the bounded source rows. The deterministic
private qualification helper
`.private/centurion-dashboard-tools-execution/u11-private-qualification.mjs`
then emitted the pre-outcome manifest/aggregate/receipt from those bounded
fields. Explicit existence checks for the bounded named paths
`phase2b-manifest.json`, `phase2b-corpus-manifest.json`,
`eligibility-manifest.json`, `holdout-freeze.json`, and `selection-freeze.json`
were absent. The helper instead froze 581 hashed members, historical-replay
mode, conversation development/holdout split, explicit skip reasons, source
qualification fields, mapping/selection hashes, evaluator-only target
exposure, and blocked outcome semantics before outcomes. It recorded 579
not-runnable cases and 2 unscorable cases; no runnable case or real eligible
gold count is asserted. Verified permission evidence and a runnable current
capability remain unproven, and the 200-episode inbound-first target remains a
frozen plan boundary with zero selected runnable episodes. This is a partial
local qualification receipt, not an external blocker and not evidence that the
real corpus is ineligible. It is not inferred from the synthetic
`eligibleGoldCases=0`.

#### Phase 2B truth boundary

The public manifest's synthetic `eligibleGoldCases=0` is not the eligibility
result for the real 420 selected records. Its own contract records synthetic
freeze/hash/held-out safeguards only. The private receipt establishes
pre-outcome membership, hashed case IDs, mode, conversation split, skip
reasons, and selection/mapping hashes for the 581-row canonical map, while
verified permission evidence, runnable eligibility, and current capability
remain unproven. No real corpus outcome, current capability, live release, or
Phase 2/B readiness claim is made. Accepted normal paths remain linked rather
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

### Final five-path edit inventory

The final U11 branch edit inventory is exactly:

1. `apps/server-pilot/scripts/reservation-pilot-gate-lib.mjs`
2. `apps/server-pilot/scripts/reservation-pilot-gate.sh`
3. `apps/server-pilot/tests/reservation-pilot-gate-dispatch.test.ts`
4. `apps/server-pilot/tests/reservation-tools-pilot-integration.test.ts`
5. `docs/infor-hms/dashboard-tools-pilot-runbook.md`

The private report and archived receipts are ignored evidence, not branch
edits; accepted U6/U13 source paths remain unchanged.

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

- All current authorized pilot users retain all configured tools/data; current
  authentication, configured source/property/ref binding, read-only PMS
  boundaries, and human approval/send remain authoritative. No new role or
  finance permission is implied.
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
  evaluator-only exposure before outcomes, but records zero runnable cases
  because permission/current capability is not proven; this is not a full U11
  or Phase 2/B completion claim.
