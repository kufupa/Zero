# Centurion Task 12 — operator report

**Result: BLOCKED**
**Date:** 2026-09-01 UTC
**Branch:** `feat/connected-mailbox-corpus`
**Pre-report HEAD:** `09adac814`
**Plan-owned handoff commit:** `732a55f565f2`
**Plan:** `docs/superpowers/plans/2026-09-01-centurion-workflow-triage-implementation.md` (U9)
**PII posture:** no message bodies, addresses, IDs, MIME, DB URLs, credentials, or keys emitted in this report.

## Gate and safety

- Read in full: Task 12 brief/base, canonical implementation plan, CE product plan, pilot-RDS safety rule, U11 promote code, v6 snapshot/retag/restore/audit scripts, spam-audit script, SSM wrappers, restart/deploy wrappers, and relevant runbook material.
- No pilot-RDS Vitest. No `VITEST_ALLOW_PILOT_RDS`. No production env sourced into any test shell. No dashboard, drafting AI, HMS activation, send, archive, suppress, or nav flip.
- Existing dirty paths preserved. No force/destructive Git operation run. No Task 12 `.private/` snapshot was created; pre-existing remote `.private/` directory was not touched.

## Step 0 / 0b — green evidence

Fresh local focused gate, with DB/test escape variables removed:

```text
env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS -u NODE_ENV \
  pnpm --filter @zero/server exec vitest run \
  tests/ai-triage-contract.test.ts tests/ai-triage-refine.test.ts \
  tests/never-spam.test.ts tests/ai-worker-contract.test.ts \
  tests/promote-quarantine.test.ts tests/retag-centurion-triage.test.ts \
  tests/centurion-triage-snapshot.test.ts tests/centurion-triage-audit.test.ts \
  tests/spam-fp-v6.test.ts tests/task-8-workflow-durable-apply.test.ts

Test Files  10 passed (10)
Tests       142 passed | 30 skipped (172)
Duration    5.56s
```

`tests/spam-fp-v6.test.ts` passed. Its protected-regression assertion passed with exact value:

```text
legitimate-mail-marked-spam=0
```

This covers current local refine/apply, U11 unit, v6 retag/snapshot/audit, worker contract, and spam-FP rails. Task 4–11 reviewed-green disposition supplied by caller remains prerequisite context; old task reports are historical and were not treated as live pilot evidence.

## Step 1 — U11 promote and outbound proof

### Access and wrapper checks

```text
aws sts get-caller-identity --query '{Account:Account,Arn:Arn}' --output json
{
  "Account": "845242190536",
  "Arn": "arn:aws:iam::845242190536:user/ansh-cursor"
}
```

SSM wrapper shell checks passed:

```text
bash -n apps/server-pilot/deploy/ssm-run-command.sh \
  apps/server-pilot/deploy/ssm-format-invocation.cjs \
  apps/server-pilot/deploy/ops-restart.sh \
  apps/server-pilot/deploy/ops-deploy.sh
```

Remote read-only probe:

```text
REMOTE_SHA=d62f5a8974
WORKFLOW_NAV_V6=
TRIAGE_RUN_STATES=[{"state":"succeeded","count":4552}]
```

Prior blocker: deployed checkout was stale relative to plan-owned U11 code. The standard sync path remains unsafe because `sync-ec2-git-bundle.sh` executes `git checkout -f` and `git reset --hard`.

### Resume safe deployment evidence

The approved reversible path succeeded without touching tracked or untracked remote work:

```text
local/target SHA=732a55f565f2c1d6510395cf2ad44e081bed4abf
temporary bundle=git-bundles/task12-resume-<unique>.bundle (uploaded, fetched, deleted; head-object absent)
remote before/after SHA=732a55f565f2c1d6510395cf2ad44e081bed4abf
tracked clean before/after=1
untracked nonignored before/after=59
untracked conflicts with target tree=0
git fetch target branch=ok
git merge --ff-only target SHA=Already up to date
```

Direct `deploy-ec2.sh` then completed through SSM from the canonical repo. Fresh read-only checks passed: `8788/health=200`, `8789/health=200`, TLS health `200`, admin health `200`, allowed PM2 processes online, HMS worker count `0`, U11 source present, tracked clean, and 59 untracked paths preserved.

### Live read-only U11 classification

A read-only SSM probe queried `missing_owner_header` rows and fetched MIME from S3 only to classify counts. It emitted counts only; no PII:

```text
{"scanned":1080,"pennyTrueStaff":103,"pennyWrapper":119,
 "pennyNoRecipient":0,"noreply":33,"otherSender":785,
 "missingObjects":0,"parseErrors":40,"expectedPromotable":103,
 "expectedWrapperSkip":119,"noreplySkipped":33}
```

Read-only message aggregate for the RC sender:

```text
{"rc_outbound":0,"rc_centurion_outbound":0,
 "rc_centurion_direction_outbound":0,
 "checked":"read-only message aggregate"}
```

Observed live counts diverge from planning calibration (~101 true / ~115 wrappers): +2 true-staff, +4 wrappers, plus 40 MIME parse errors. Counts are not fabricated or rounded into the expected calibration.

### Prior safe local U11 argument check

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec tsx scripts/promote-quarantine.ts --dry-run
→ promote failed: env missing required: PORT, DATABASE_URL, BETTER_AUTH_URL,
  BETTER_AUTH_SECRET, AWS_REGION, S3_BUCKET
```

This remains expected local no-credential behavior. Unit tests validate U11 argument/predicate behavior; live work used only the deployed operator env through SSM.

### Resume live U11 evidence

Sanitized SSM counts (IDs, MIME, bodies, addresses, and DB URL omitted):

```text
dry-run: scanned=1080 candidates=103 skipped=937 errors=40 rc_outbound_before=0
apply:   scanned=1080 stored=0 duplicate=0 quarantined=103 skipped=937 errors=40 rc=1
rc_outbound_after=0
```

The 40 parse errors match the earlier read-only classifier residual. All 103 classifier candidates reached `persistInboundMessage`, but none stored: its routing still requires a Centurion direct-To/equated identity before `directionOverride: outbound` is applied. These RC staff messages have no such route identity, so the existing `missing_owner_header` quarantine rows remained and outbound proof stayed zero. Post-check: `missing_owner_header` quarantine count `1080`, `WORKFLOW_NAV_V6` off, remote tracked clean, 59 untracked paths preserved.

### Step 1 blocker

**Exact blocker:** safe code deployment is now available and green, but U11 apply stores `0/103` candidates because promotion has no explicit Centurion transport routing override; all 103 remain quarantined and live RC outbound proof is `0`. Do not proceed to snapshot, retag, restore, cohorts, audit, spam audit, or nav flip until promotion routing is fixed, tested, deployed through the same non-destructive path, and U11 apply proves RC outbound `>0`.

## Steps 2–9 — dependency gate

Not run. Exact order requires U11 promote + read-only RC outbound proof before snapshot. Consequently:

- Step 2 snapshot and full eligible target manifest: **not run**; no raw PII artifact or Task 12 snapshot created; pre-existing remote `.private/` untouched.
- Step 3 retag dry-run: **not run**.
- Step 4 restore drill dry-run: **not run**.
- Steps 5–7 cohorts (50 → 250 → remainder), worker drain, and per-cohort audits: **not run**.
- Step 8 spam audit / never-spam and staff-outbound zero proof: **not run**.
- Step 9 `WORKFLOW_NAV_V6`: **not flipped**. Remote value remains empty/off.

Local script syntax and argument validation still ran safely:

```text
node --check snapshot-centurion-triage.mjs                  → pass
node --check retag-centurion-triage.mjs                     → pass
node --check restore-centurion-triage-snapshot.mjs          → pass
node --check audit-centurion-triage-retag.mjs               → pass
node --check dump-centurion-spam-audit.mjs                  → pass

retag-no-scope                  → require --targets ... or --from-domain ...
retag-apply-no-targets          → full v6 --apply requires --targets ...
retag-targets-domain-conflict   → --targets must not use --from-domain
snapshot-targets-no-out         → --out <snapshot.json> required
restore-no-snapshot             → --snapshot <snapshot.json> required
audit-missing-input             → require --summary ... --manifest ... --snapshot ... --key-prefix ...
```

Local `dump-centurion-spam-audit.mjs --out /tmp/task12-spam-audit.json` returned `DATABASE_URL required`; no local DB access was invented.

## Step 10 — handoff and residuals

Plan-owned handoff written at:

`docs/superpowers/plans/handoff-reports/2026-09-01-centurion-task-12.md`

Residuals recorded:

| Residual | Count / state |
|---|---:|
| U11 quarantine scanned | 1,080 |
| True Penny staff candidates (read-only classifier) | 103 |
| U11 apply stored / duplicate / quarantined | 0 / 0 / 103 |
| Penny Legacy-only wrappers | 119 |
| Penny no-recipient | 0 |
| ReserveCloud noreply | 33 |
| Other sender | 785 |
| MIME parse errors | 40 |
| Missing S3 objects | 0 |
| Existing RC outbound messages | 0 |
| RC outbound after U11 apply | 0 (proof failed) |
| Eligible snapshot/backfill universe | not measured (order blocked) |
| Locked/block/allow/outbound-only residuals | not measured (order blocked) |

No counts imply promotion or backfill. Status remains **BLOCKED**, not DONE/DONE_WITH_CONCERNS. Resume requires a narrow tested transport-routing fix for U11, the same safe deployment gate, fresh dry-run/apply counts, and RC outbound `>0` proof before continuing exact sequence.

## Audit RCA follow-up — 2026-09-01 UTC

**Status:** code-level audit reconciliation fixed; the live U11 routing blocker above is unchanged.

### Root causes fixed

- The audit input-hash reconstruction omitted message recipient metadata (`to`, `cc`,
  and `bcc`) and the worker-derived thread signals. It now selects those columns,
  normalizes them with the production hash contract, sorts by causal `(createdAt, id)`,
  cuts off after the trigger, and derives the same Legacy/ReserveCloud signals as the
  worker.
- The worker can remap a canonical workflow primary during durable apply (for staff
  and protected sender exceptions). The audit now computes expected durable slugs and
  urgent/spam expectations from that same effective decision while preserving the
  approved-output comparison.

### TDD evidence

- RED: the new canonical durable-remap integration test failed before the audit loop
  consumed the effective durable decision.
- GREEN: the audit test suite passed after wiring the decision and fixing the
  recipient-list shape boundary.

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run \
  tests/centurion-triage-audit.test.ts --maxWorkers=1
→ 1 file, 21 tests passed
```

Fresh adjacent script gate:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run \
  tests/centurion-triage-audit.test.ts \
  tests/retag-centurion-triage.test.ts \
  tests/centurion-triage-snapshot.test.ts --maxWorkers=1
→ 3 files, 51 tests passed
```

The suite also covers the Postgres audit driver selecting recipient columns and
excluding post-trigger messages from the production input hash. No live DB write,
deploy, requeue, or nav-flag change was performed for this RCA.
