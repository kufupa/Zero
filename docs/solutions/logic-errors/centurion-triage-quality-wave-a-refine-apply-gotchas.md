---
title: Centurion Triage Quality Wave A — Refine Forces, Apply Txn, Quarantine Scope, Series-Release isSpam
date: 2026-09-02
category: logic-errors
module: server-pilot / centurion workflow triage refine + mail My folders
problem_type: logic_error
component: email_processing
severity: high
symptoms:
  - "Routine OTA/SynXis/channel mail stayed Urgent or wrong folder despite prompt-only triage quality plan"
  - "Coverage-only audit passed while automated-channel folder stayed empty and promo/FortiMail digests lost spam placement"
  - "applyDurableTriageResult spam path threw or failed when test helpers passed an already-open Drizzle transaction"
  - "Quarantine My Folder listed under archive chrome (Move to Inbox, archive actions) instead of spam folder + labelIds"
  - "Series-release threads with model isSpam:true never reached exceptions-recovery — apply spam early-return blocked category joins"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - frontend_stimulus
  - testing_framework
  - background_job
tags:
  - centurion
  - workflow-triage
  - refine
  - automated-channel
  - force-spam
  - quarantine
  - series-release
  - drizzle-transaction
  - my-folders
  - wave-a
---

# Centurion Triage Quality Wave A — Refine Forces, Apply Txn, Quarantine Scope, Series-Release isSpam

## Problem

Wave A of Centurion triage quality (branch `fix/phaseone`, commits `fda24f42`–`007ea758`) restored reservationist folder mix: routine channel mail → `automated-channel`, promo/cold-sales and FortiMail digests → spam (+ Quarantine label), series-release → `exceptions-recovery`. Four non-obvious integration bugs hid regressions until code-level refine forces, apply-path txn handling, FE spam-scoped chrome, and `isSpam` clearing on series-release landed.

## Symptoms

- Prompt-only or model-output changes alone did not move OTA/channel traffic into `automated-channel` or promo digests into spam; a coverage-only audit could still look green while Automate stayed empty and spam counts dropped.
- Vitest apply tests and nested worker callers failed when `applyDurableTriageResult` always called `db.transaction()` on a client that was already a transaction (no `.transaction` method).
- Selecting the **Quarantine** My Folder showed archive-like toolbar chrome and `folder=archive` semantics in some surfaces even though list queries correctly used `folder=spam` + `labelIds`.
- Held series/allocation release mail refined to `exceptions-recovery` but durable apply stamped `spam_at` and returned early when the model had left `isSpam: true`, so category joins never wrote.

## What Didn't Work

- Relying on triage prompt or model compliance without `refineWorkflowTriageOutput` **force** steps — refine is the deterministic contract; audits that only check cohort coverage miss empty `automated-channel` and spam wipeouts.
- Unconditional `db.transaction()` inside apply spam writes — Drizzle nested transactions are not supported when the caller already passed an open `tx`.
- Scoping Quarantine only in `resolveMailRouteFilter` — archive-like helpers (`isArchiveLikeMailFolder`, thread actions, optimistic move) still treated the UUID route as archive filing.
- Remapping `primaryFolder` to `exceptions-recovery` on series-release without clearing `isSpam` — `effectiveIsSpam` stayed true and the spam branch short-circuited before category resolution.

## Solution

### 1. Workflow refine must **force** Automate and spam (ordered pipeline)

`refineWorkflowTriageOutput` in `apps/server-pilot/src/ai/triage.ts` runs deterministic forces in order:

1. **Series-release** → `exceptions-recovery`, `isSpam: false`, `urgent: false`
2. **Force spam** — FortiMail quarantine digest or promo/cold-sales (`shouldForceWorkflowPromoSpam`), unless never-spam / staff / hotel-conversation protected
3. **Force automate** — `isRoutineSystemMail` → `automated-channel`, `urgent: false`, `refine:system-mail-automated`
4. Internal-property demotion, finance routing, etc.

```ts
if (isSeriesReleaseAtRisk(haystack)) {
  next = {
    ...next,
    primaryFolder: 'exceptions-recovery',
    isSpam: false,
    urgent: false,
    suggestedTools: [],
    policyFlags: addPolicyFlag(next.policyFlags, 'refine:series-release-at-risk'),
  };
} else if (
  !isProtectedFromWorkflowForceSpam(input, neverSpamFrom, notSpam) &&
  (isFortiMailQuarantineDigest(haystack) || shouldForceWorkflowPromoSpam(input, haystack))
) {
  next = { ...next, isSpam: true, urgent: false, /* refine:fortimail-spam | refine:promo-spam */ };
} else if (isRoutineSystemMail(input, haystack) && !isFortiMailQuarantineDigest(haystack) && !hasRevenueRisk(haystack)) {
  next = {
    ...next,
    primaryFolder: 'automated-channel',
    urgent: false,
    policyFlags: addPolicyFlag(next.policyFlags, 'refine:system-mail-automated'),
  };
}
```

Gold fixtures in `apps/server-pilot/tests/fixtures/centurion-triage-quality-gold.json` and `ai-triage-refine.test.ts` lock Q1 Automate and Q2/Q3 spam floors. Quality audits must assert folder **population**, not prompt compliance alone.

### 2. Apply spam path — optional transaction when `db` is already a tx

FortiMail spam apply atomically sets `spam_at` and attaches/strips the **Quarantine** user label. Callers include root DB clients and test helpers that pass an already-open transaction.

```ts
const writeSpamAndQuarantine = async (tx: typeof db) => { /* label + spam_at */ };
if (typeof db.transaction === 'function') {
  await db.transaction(async (tx) => {
    await writeSpamAndQuarantine(tx as unknown as typeof db);
  });
} else {
  await writeSpamAndQuarantine(db);
}
```

Pattern: prefer nested txn on root client; run inline when `.transaction` is absent.

### 3. Quarantine My Folder — spam-scoped across all archive-like chrome

`RESERVED_SPAM_SCOPED_LABEL_NAMES = ['Quarantine']` in `apps/mail/lib/mail/route-filter.ts`. `buildReservedSpamLabelIdSet` maps label name → UUID for hooks/nav.

- **List route:** `resolveMailRouteFilter` → `{ folder: 'spam', filters: { labelIds: [id] } }` (not `archive`).
- **Archive-like chrome:** `isArchiveLikeMailFolder` returns `false` for reserved spam-scoped label IDs.
- **Thread actions:** `isActionAvailable` / filing snapshots treat Quarantine like spam (no archive-only actions).
- **Hooks/components:** `use-threads`, `thread-context`, `mail-list`, `thread-display`, `use-optimistic-actions` thread `reservedSpamLabelIds` through.

Contract tests: `search-filter-contract.test.ts`, `thread-actions-contract.test.ts`.

### 4. Series-release must clear `isSpam` before apply

When `refine:series-release-at-risk` fires, `isSpam: false` is mandatory. Without it, threads with prior `spam_at` or model `isSpam: true` hit `effectiveIsSpam` and the spam early-return — `exceptions-recovery` joins never apply.

`workflowUnsettledNotSpam` in apply also rewrites settled spam when refine cleared `isSpam` but `spam_at` remains (unsettled primary + spam flag mismatch).

Test: `workflow: series-release clears model isSpam so apply does not spam early-return` in `ai-triage-refine.test.ts`.

## Why This Works

Centurion triage quality is a **refine-then-apply** pipeline, not a prompt exercise. Model output is nondeterministic; ordered refine forces encode product policy (Automate vs spam vs exceptions-recovery) deterministically before durable writes.

Drizzle transactions are not re-entrant on an existing `tx` handle — optional txn respects both production root clients and test nested callers without sacrificing atomic label+spam writes on the root path.

My folders use two filing geometries: **archive+labelIds** (default UUID routes) vs **spam+labelIds** (Quarantine). Route-filter alone is insufficient; any helper that treats “user folder UUID” as archive-like must consult `reservedSpamLabelIds`.

Spam durable state is `mail_thread.spam_at`, orthogonal to `primaryFolder`. Series-release is a work-queue remap; leaving `isSpam: true` tells apply to spam-stamp and return before category resolution — the opposite of exceptions-recovery intent.

## Prevention

- Add refine contract tests for every quality gate (Automate population, force-spam, series-release `isSpam: false`) before trusting coverage-only audits.
- When adding apply mutations that call `db.transaction`, guard with `typeof db.transaction === 'function'` or accept `tx` as a parameter from callers.
- New My Folder names that live under Spam must join `RESERVED_SPAM_SCOPED_LABEL_NAMES` and thread `reservedSpamLabelIds` through list, actions, and optimistic UI — not only `resolveMailRouteFilter`.
- Any refine step that remaps `primaryFolder` away from spam must set `isSpam: false` when the thread should receive category joins.
- Wave B (retag audit `--quality`, Q11 volume, `forceUnsettle` re-backfill) builds on this refine/apply contract — do not skip Wave A forces when re-running cohorts.

## Related Issues

- Plan: `docs/superpowers/plans/2026-09-02-centurion-triage-quality-implementation.md`
- Spam folder truth: `docs/solutions/architecture-patterns/folder-first-spam-at-folder-matrix.md`
- Retag audit semantics: `docs/solutions/logic-errors/centurion-triage-audit-createdat-vs-finishedat-spam-at.md`
- My folders filing: `docs/solutions/architecture-patterns/my-folders-label-archive-filing.md`
- Key files: `apps/server-pilot/src/ai/triage.ts`, `apps/mail/lib/mail/route-filter.ts`, `apps/mail/lib/thread-actions.ts`, `apps/server-pilot/tests/ai-triage-refine.test.ts`
