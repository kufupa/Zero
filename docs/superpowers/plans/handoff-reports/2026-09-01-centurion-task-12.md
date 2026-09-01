# Centurion Task 12 handoff — BLOCKED

**Date:** 2026-09-01 UTC

**Result:** `BLOCKED`

**Plan unit:** U9 / Task 12

**Pre-report HEAD:** `09adac814`

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

## Blocker and non-actions

Safe deployment blocker is resolved. New blocker: U11 transport routing must be fixed and tested so candidates can bind to `transport-centurion`; then redeploy safely and re-prove RC outbound `>0`.

Dependency order held. No snapshot, targets, retag, restore, cohorts, worker drain, audit, spam audit, or nav flip ran. No Task 12 `.private/` snapshot created. Existing dirty paths preserved; remote tracked tree clean and 59 untracked paths untouched.

## Resume command

Add/test narrow Centurion transport routing for U11. Deploy matching code through safe bundle + ff-only + direct `deploy-ec2.sh`; rerun dry-run/apply, verify RC outbound `>0`, then continue Task 12 steps 2–10 in order. Do not flip `WORKFLOW_NAV_V6` before green post-apply audit.
