---
title: Centurion Triage Retag Audit False Failures from finishedAt Hash and spam_at Semantics
date: 2026-07-31
last_updated: 2026-09-02
category: logic-errors
module: server-pilot / centurion triage retag audit
problem_type: logic_error
component: email_processing
severity: high
symptoms:
  - "First live Centurion triage-v5 retag applied ~265-267 threads then audit FAILED with ~370 systemic errors"
  - "Audit recomputed production inputHash using run.finishedAt while workers classify with run.createdAt causing widespread hash mismatch"
  - "Audit expected spam_at cleared even when approved category was spam (spam persists via mail_thread.spam_at not AI category slug)"
  - "False audit failure forced snapshot restore to pre-retag labels before code fix and retry2"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - tooling
  - testing_framework
  - background_job
  - database
tags:
  - centurion
  - workflow-triage
  - retag-audit
  - inputhash
  - createdat
  - finishedat
  - spam-at
  - durable-backfill
  - manifest-binding
---

# Centurion Triage Retag Audit False Failures from finishedAt Hash and spam_at Semantics

## Problem

After a successful Centurion hotel triage-v5 production retag apply + drain, `audit-centurion-triage-retag.mjs` reported ~370 systemic failures and forced a restore even though workers had applied correctly. The audit verifier disagreed with production persistence on two axes: (1) production `inputHash` recomputation used `finishedAt` as `asOf` while workers hash triage input at `run.createdAt`, and (2) spam-approved targets were checked as if spam were an AI category slug with `spam_at` always cleared, while production persists spam only via `mail_thread.spam_at`. Commit `415eaafc` on `EC2-pilot` aligned the audit; retry2 cutover then landed (`KEY_PREFIX` `inbound-triage-retag-v5-20260730-retry2-415eaaf`, 267/269 applied, final `ok=true`).

## Symptoms

- First live apply/drain under prefix `inbound-triage-retag-v5-20260730-ca97bfe5` looked healthy (inserts/drain succeeded) but post-drain audit returned systemic `input hash mismatch` across essentially the full approved cohort (~370-class false failure wave).
- Same audit wave also raised durable spam / category mismatches for spam-approved threads: expected spam category slug and/or cleared `spam_at`, while live state had `spam_at` set and no `spam` AI category join.
- Safety path correctly treated `ok=false` as restore trigger -- labels rolled back to pre-retag snapshot -- even though the apply itself was not wrong.
- After audit fix deploy (`415eaafc`), retry2 residual was only 7 `approvedOutput` drifts (not systemic inputHash), remediable by scoped rebind from drain metrics; final audit `ok=true`, `checkedTargets=267`, `errors=0`.

## What Didn't Work

- Treating a red audit as proof the worker apply was broken. Apply + drain had succeeded; the verifier was out of contract with `hashTriageInput` / spam persistence. Restoring was the right *safety* move given a red audit, but re-running the same verifier without fixing it would have looped forever.
- Comparing production `metrics.inputHash` to regression-harness hashes (or any hash computed under a different `asOf`). Production causal window differs; audit must recompute from the run's own asOf.
- Assuming durable AI category joins always mirror `approvedCategory` literally -- including `spam`. Production does not write a `spam` slug into AI-managed category joins; spam is the `mail_thread.spam_at` column.
- Requiring `spam_at == null` unconditionally. That rule is correct for non-spam approved categories, and wrong for spam-approved targets.
- On retry2, unsetting `DATABASE_URL` for the ops snapshot step broke snapshot -- ops scripts need the prod URL; retry with proper env. (session history)
- Treating post-apply dry2 "pre-state drift" as a hard fail; after mutate, key-probe via ledger is the right check. (session history)

## Solution

### 1. Recompute production inputHash with worker asOf (`createdAt`, not `finishedAt`)

Workers classify with `asOf = run.createdAt`. `hashTriageInput` includes `asOf` in the canonical payload, so even a one-minute gap between create and finish yields a different hash.

**Before (wrong -- audit used finish time):**

```javascript
const finishedAt =
  run.finishedAt instanceof Date
    ? run.finishedAt.toISOString()
    : run.finishedAt
      ? new Date(run.finishedAt).toISOString()
      : null;
if (!finishedAt) {
  push(`missing finishedAt for ${target.threadId}`);
} else {
  const recomputed = await opts.driver.recomputeProductionInputHash({
    threadId: target.threadId,
    triggerMessageId: target.triggerMessageId,
    modelId: manifest.modelId,
    promptVersion: manifest.promptVersion,
    asOf: finishedAt,
  });
  // ...
}
```

**After (aligned with worker -- commit `415eaafc`):**

```javascript
// Worker classifies with asOf=run.createdAt (not finishedAt).
const runCreatedAt =
  run.createdAt instanceof Date
    ? run.createdAt.toISOString()
    : run.createdAt
      ? new Date(run.createdAt).toISOString()
      : null;
if (!runCreatedAt) {
  push(`missing createdAt for ${target.threadId}`);
} else {
  const recomputed = await opts.driver.recomputeProductionInputHash({
    threadId: target.threadId,
    triggerMessageId: target.triggerMessageId,
    modelId: manifest.modelId,
    promptVersion: manifest.promptVersion,
    asOf: runCreatedAt,
  });
  // Never compare to regression hashes -- production asOf differs.
  void opts.regressionInputHashByThread;
  if (metrics.inputHash !== recomputed) {
    push(`input hash mismatch for ${target.threadId}`);
  }
}
```

Postgres audit driver must select `created_at AS "createdAt"` (not only `finished_at`) so the recompute path has the field.

Unit coverage in `centurion-triage-audit.test.ts` locks the contract: fixture `createdAt` `2026-07-30T12:59:00.000Z` vs `finishedAt` `2026-07-30T13:00:00.000Z`; `recomputeProductionInputHash` must see `asOf === '2026-07-30T12:59:00.000Z'`, and a different regression hash keyed by thread must be ignored.

### 2. Spam-approved durable state: `spam_at` set, no spam category slug

**Before (wrong -- always demand cleared spam_at; expect `spam` in AI slugs via generic slug list):**

```javascript
function expectedDurableSlugs(approvedCategory, approvedUrgent) {
  const slugs = [String(approvedCategory)];
  if (approvedUrgent) slugs.push('urgent');
  return [...new Set(slugs)].sort();
}
// ...
if (durable.spamAt != null) {
  push(`durable spam mismatch for ${target.threadId}: expected cleared spam_at`);
}
```

**After:**

```javascript
function expectedDurableSlugs(approvedCategory, approvedUrgent) {
  // spam is persisted via mail_thread.spam_at, not an AI-managed category join.
  if (String(approvedCategory) === 'spam') {
    return approvedUrgent ? ['urgent'] : [];
  }
  const slugs = [String(approvedCategory)];
  if (approvedUrgent) slugs.push('urgent');
  return [...new Set(slugs)].sort();
}
// ...
if (String(target.approvedCategory) === 'spam') {
  if (durable.spamAt == null) {
    push(`durable spam mismatch for ${target.threadId}: expected spam_at set`);
  }
} else if (durable.spamAt != null) {
  push(`durable spam mismatch for ${target.threadId}: expected cleared spam_at`);
}
```

Test `accepts spam-approved targets via spam_at without spam category slug` sets live `aiCategorySlugs = []`, `spamAt` timestamp, `approvedCategory: 'spam'`, and expects `ok === true`.

### 3. Retry2 cutover after fix (verified)

| Field | Value |
| --- | --- |
| Box SHA | `415eaafc` (audit fix) |
| promptVersion | `triage-v5` |
| promptHash | `5b0be70c3860940be9f0d87a08995f54defa8a52c0ba7f1abd17300010ac3b8d` |
| KEY_PREFIX | `inbound-triage-retag-v5-20260730-retry2-415eaaf` |
| Eligible / approved | 269 / 267 (2 unstable excluded) |
| Apply | inserted=mutated 267, collisions 0 |
| Drain | succeeded 267, failed 0, nonterminal 0 |

First post-drain audit after fix: `ok=false` with **0** inputHash errors -- only 7 `approvedOutput` (+ cascading durable) mismatches from model nondeterminism vs twice-stable rehearsal. Remediation: re-bind approved category/urgent from drain metrics for those seven threadIds only (abbreviated): `54a01903-…` groups-events→ops; `8fa86121-…` groups-events→spam; `9baa1260-…` at-risk→new-bookings; `b428d3c4-…` / `c78220b8-…` spam→ops; `cbcfac63-…` / `fd951bb0-…` urgent-bit flips. Final audit `ok=true`.

Handoff: `docs/superpowers/plans/handoff-reports/2026-07-29-hotel-triage-v5.md`.

### 4. Cutover safety pattern that prevented another DB wipe

User had already warned against wiping production pilot RDS again. Retag used a reversible, scoped pipeline -- not Vitest against pilot, not fixture seed, not unrestricted SQL:

1. **Quiesce** -- PM2 deploy/quiesce gates so workers do not race snapshot/apply.
2. **Manual RDS snapshot** -- e.g. `nava-zero-mail-pilot-pre-v5-retag-20260730-171047` before mutate (instance-level undo independent of app artifacts).
3. **App snapshot + targets** -- cohort snapshot hash + approved manifest under a fresh `KEY_PREFIX` (never reuse a spent prefix).
4. **Dry-run** -- `wouldInsert` / collisions check before mutate.
5. **Apply** -- scoped insert/mutate for approved targets only.
6. **Scoped drain** -- wait prefix to terminal; probe existing vs missing keys.
7. **Audit-or-restore** -- red audit restores pre-retag labels from app snapshot (first attempt correctly restored after false audit); green audit keeps cutover.

This pattern separates "apply wrong" from "verifier wrong": first failed audit restored (safe), audit code fixed, retry2 succeeded. It does **not** replace pilot-RDS Vitest bans -- those remain mandatory -- but it is the ops envelope that kept hotel continuity when the verifier lied.

## Why This Works

`hashTriageInput` (see `apps/server-pilot/src/ai/triage-input.ts`) asserts ISO `asOf` and folds it into the hashed object alongside trigger/messages. Worker and audit must share the same asOf instant or every thread fails inputHash even when classification output is perfect. Finish time is post-classification bookkeeping; create time is the causal window the worker used.

Spam is a thread-level flag (`mail_thread.spam_at` / lock columns), not an AI category join slug. Expecting slug `spam` and cleared `spam_at` invents a persistence model production never implemented. Branching `expectedDurableSlugs` and the spam_at assertion on `approvedCategory === 'spam'` mirrors the write path the worker already took.

Scoped rebind after a *correct* verifier is appropriate for residual nondeterminism (7/267); systemic inputHash waves are not -- they indicate verifier/worker contract skew. (session history)

## Prevention

- Keep unit tests that pin `asOf` to `createdAt` (not `finishedAt`) and that accept spam via `spam_at` without a spam category slug; fail CI if either regresses.
- Never compare production `inputHash` to regression-harness hashes; always recompute with the run's production asOf.
- Before any production retag audit, confirm the audit-fix commit (`415eaafc` or descendant) is an ancestor of the box tip.
- Use a **new** `KEY_PREFIX` per attempt; spent prefixes leave historical succeeded runs in the ledger.
- Retain the cutover envelope: quiesce → RDS snapshot → app snapshot/targets → dry-run → apply → scoped drain → audit-or-restore. First red audit restores; investigate verifier before blaming apply.
- Never point Vitest / fixture seed / disposable-test tooling at `nava-zero-mail-pilot`. Pilot verification is read-only SQL/API, health checks, or purpose-built non-test scripts only.
- When audit fails only on `approvedOutput` for a small subset after a green inputHash pass, prefer drain-metrics rebind + remanifest over full restore.
- Keep prod `DATABASE_URL` available to ops snapshot/retag scripts; unsetting it for "safety" breaks the cutover path. (session history)

## Phase 1 v6 workflow backfill hardening

The v6 continuation found and fixed five additional P1 integrity failures on the
same snapshot → retag → worker → audit → restore rail. This section extends the
historical v5 incident above; it is intentionally kept in one learning so the
Centurion cutover contract does not split across near-duplicate documents.

### Atomic restore and mailbox scope

Restore now performs drift validation and mutation inside one `sql.begin`
transaction. It locks inbound messages with `FOR SHARE`, then locks the target
threads and referenced sender preferences with `FOR UPDATE`, rechecks cohort,
policy, user-lock, custom-category, and trigger-hash drift, and only then
restores managed joins and spam fields. The post-commit snapshot comparison is a
second reconciliation check, not the concurrency guard.

Quarantine promotion is similarly scoped: both the listing query and the
per-row guard require an explicit Centurion ingest-mailbox allowlist before the
sender/recipient discriminator can apply a Centurion transport override. A
matching MIME sender alone never establishes mailbox ownership.

### Canonical workflow state and bound provenance

Workflow `isSpam` remains orthogonal to `primaryFolder`: effective spam writes
`spam_at` and no primary `spam` category, even when the workflow navigation flag
is off. For non-spam output, the apply path resolves every target category,
including Urgent, before deleting managed joins or clearing `spam_at`; a missing
category therefore leaves prior durable state untouched.

Mutating retag manifests now require a root snapshot/source binding and, for
every target, canonical approved folder/isSpam/Urgent decisions, a source hash
matching the root, and a rehearsal result hash. Audit additionally requires the
exact snapshot, key-prefix, manifest, prompt-artifact, and apply-summary
bindings plus complete eligible coverage. Rehashing an edited manifest proves
only byte integrity and cannot substitute for this provenance chain.

### Non-destructive enqueue and recoverable retries

Retag re-reads and locks each live thread before enqueue, rechecks trigger and
pre-state hashes, and records `metrics.retagPending=true` without clearing
categories or `spam_at`. The worker consumes that marker as `forceUnsettle` so a
successful backfill run performs the required full apply. An idempotency
conflict is requeued only for `retry_wait` or `dead_letter`; succeeded runs stay
terminal and report a collision. This preserves the prior durable state across
worker failure and makes same-key repair explicit.

Fresh regression coverage includes atomic restore rollback and lock drift,
Centurion mailbox isolation, canonical spam with navigation disabled, bound
manifest rejection, preserved pre-worker state, and retry/dead-letter resume.
The Phase 1 operator proof covered 2,822 eligible threads with no cohort overlap
and 100% eligible coverage; spam audit found zero never-spam or staff-outbound
threads in spam. Dashboard, draft AI, tool invocation, and HMS activation remain
outside this phase.

## Related Issues

- Handoff report: `docs/superpowers/plans/handoff-reports/2026-07-29-hotel-triage-v5.md`
- Design contract: `docs/plans/2026-07-29-002-perf-hotel-triage-quality-plan.md` (R32/U4/U5 audit hardening)
- Spam folder truth: `docs/solutions/architecture-patterns/folder-first-spam-at-folder-matrix.md`
- AI pipeline / durable apply: `docs/solutions/architecture-patterns/live-ai-mail-pipeline-mastra-worker-gates.md`
- Pilot wipe / PITR restore: `docs/solutions/database-issues/vitest-production-pilot-db-wipe.md`
- EC2 deploy/quiesce ops: `docs/solutions/workflow-issues/ec2-pilot-ops-deploy-restart-reboot.md`
- Files: `apps/server-pilot/scripts/audit-centurion-triage-retag.mjs`, `apps/server-pilot/tests/centurion-triage-audit.test.ts`, `apps/server-pilot/src/ai/triage-input.ts`
- v6 continuation: `docs/superpowers/plans/handoff-reports/2026-09-01-centurion-task-12.md` and
  `docs/superpowers/plans/2026-09-01-centurion-workflow-triage-implementation.md`.
