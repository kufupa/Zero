# Centurion Task 12 handoff — COMPLETE

**Date:** 2026-09-02 UTC (continuation of the 2026-09-01 run)

**Result:** `COMPLETE`

**Plan unit:** U9 / Task 12

**Pre-report HEAD:** `e8c8b8768`

> **Authority note:** The `Final continuation result — 2026-09-02 UTC` section is
> the sole current status and supersedes the earlier blocked/resume narratives
> below. Those sections are retained only as an operator history of the
> resolved U11 routing incident; they are not current gate results.

## Gate result

Local safe gate is green:

```text
10 Vitest files passed; 142 passed, 30 skipped.
spam-fp-v6 protected regression: legitimate-mail-marked-spam=0.
```

No pilot-RDS Vitest, no pilot escape hatch, no production env in a test shell, no dashboard/draft/HMS work.

## Prior live blocker evidence

EC2 SSM access worked, but prior deployed source was stale:

```text
remote SHA=d62f5a8974
WORKFLOW_NAV_V6= (off)
triage runs: succeeded=4552
```

Read-only S3/DB U11 classification:

```text
quarantine=1080
true Penny staff=103
Penny Legacy-only wrappers=119
noreply=33
other=785
parse errors=40
missing S3=0
```

Read-only message aggregate:

```text
RC sender messages with outbound direction=0
RC Centurion outbound=0
```

Calibration divergence: +2 true staff / +4 wrappers versus ~101/~115; 40 parse errors require explicit handling.

## Resume deployment evidence

Safe temporary bundle path completed:

```text
target SHA=732a55f565f2c1d6510395cf2ad44e081bed4abf
remote SHA before/after=732a55f565f2c1d6510395cf2ad44e081bed4abf
tracked clean before/after=1
untracked nonignored before/after=59
target-tree untracked conflicts=0
ff-only merge=Already up to date
temporary bundle uploaded/fetched/deleted
```

Direct `deploy-ec2.sh` via SSM completed. Read-only post-deploy checks: loopback `8788/8789` health `200`, TLS health `200`, admin health `200`, allowed PM2 processes online, HMS worker `0`, U11 source present.

## Resume U11 result

```text
dry-run: scanned=1080 candidates=103 skipped=937 errors=40 rc_outbound_before=0
apply: scanned=1080 stored=0 duplicate=0 quarantined=103 skipped=937 errors=40 rc=1
rc_outbound_after=0
missing_owner_header quarantine after apply=1080
WORKFLOW_NAV_V6=off
```

Apply did not promote any candidate. The classifier accepts exact RC sender plus a non-Legacy recipient, but persistence routing still requires a Centurion direct-To/equated identity before its outbound direction override runs. All 103 candidates therefore remained in `missing_owner_header`; no outbound proof exists. The 40 parse errors remain known residuals. No Task 12 snapshot was created; pre-existing remote `.private/` was untouched.

## Historical blocker (resolved)

The original U11 transport-routing blocker was resolved by the narrow Centurion routing fix and a safe redeploy. The evidence below supersedes the earlier blocked result.

Dependency order held. No snapshot, targets, retag, restore, cohorts, worker drain, audit, spam audit, or nav flip ran. No Task 12 `.private/` snapshot created. Existing dirty paths preserved; remote tracked tree clean and 59 untracked paths untouched.

## Historical resume command (superseded)

Add/test narrow Centurion transport routing for U11. Deploy matching code through safe bundle + ff-only + direct `deploy-ec2.sh`; rerun dry-run/apply, verify RC outbound `>0`, then continue Task 12 steps 2–10 in order. Do not flip `WORKFLOW_NAV_V6` before green post-apply audit.

## Final continuation result — 2026-09-02 UTC

### U11 promotion and runtime

```text
remote deployed source: 142e218addb0ba17459ea227c45578353b5ee659
U11 resume dry-run: scanned=977 candidates=0 skipped=937 errors=40
U11 resume apply: no additional candidates; residual parse/missing-owner classes retained
RC sender messages: 103
RC Centurion outbound messages: 103
```

The 40 parse-error rows and non-equated/missing-owner quarantine residuals remain explicitly logged; they are outside the eligible inbound-trigger universe. No HMS process was started.

### Full backfill evidence

Existing frozen cohort proof remains valid: c50 `50/50`, c250 `250/250`, and the original remainder `2520/2520`, disjoint union `2820`. Eight non-spam approved-manifest reconciliation repairs were applied after the first remainder drain; the initial metrics serialization issue was corrected and all 2,520 remainder metrics are JSON objects.

Post-ingest residual proof was then run for the two new eligible threads created after the 2,820-thread boundary:

```text
post-ingest targets: 2
retag dry-run: eligible=2 wouldInsert=2 mutated=0
retag apply: inserted=2 mutated=2
direct scoped drain: processed=2 remainingNonterminal=0
strict audit: checkedTargets=2 errors=[]
```

Final live snapshot and coverage:

```text
eligible=2822 locked=2 blocked=0 allowed=7 outboundOnly=467
manifest union=2822 overlaps=0 eligibleCovered=true
```

Private artifacts (mode `0600`) are under `/home/ubuntu/repos/zero/.private/centurion-task12/`, including `snapshot-final-live-20260902.json`, `coverage-final-v6-20260902.json`, `approved-post-ingest-residual-v6-20260902.json`, and `audit-post-ingest-20260902.json`.

### Spam and safety gates

```text
Centurion threads=3298 spam=4
neverSpamInSpam=0
staffOutboundInSpam=0
spam-fp-v6 legitimate-mail-marked-spam=0
```

### Nav flip and process proof

The SPA was built with `VITE_WORKFLOW_NAV_V6=1` in quiesced mode, then only `http` and `remote-http` were restarted. Final proof: loopback `8788/8789` health `200`, `http`/`remote-http`/real-mail `worker` online, `ai-worker` stopped, and `hms-ai-worker` absent. The built assets contain `VITE_WORKFLOW_NAV_V6:"1"`. Phase 2 evidence dashboard, draft AI, and HMS activation remain unimplemented/off.

### Local verification

```text
server targeted: 16 files, 222 passed, 44 skipped
mail nav/presentation: 2 files, 20 passed
server build: passed
mail build: passed (existing sourcemap/CSS/chunk warnings only)
```

The worktree retains unrelated user changes; only plan-owned files belong in the final commit.
