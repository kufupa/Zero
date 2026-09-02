# Centurion Triage Quality — SDD Progress

- Plan: `docs/superpowers/plans/2026-09-02-centurion-triage-quality-implementation.md`
- Product SoT: `docs/plans/2026-09-02-002-feat-centurion-triage-quality-plan.md`
- Worktree: `/home/orca/orca/workspaces/zero/phase-1-fix`
- Branch: `fix/phaseone`
- Baseline: `bfb70253a508dd4b5bd605377faa30c6ce45bcb2`
- Wave: **A only** until fence CLEAR (no ops-deploy / retag / pilot write)
- Model: standard non-fast subagents; caveman ultra for agents
- Safety: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before every Vitest

## Task status

| Task | Status | Evidence |
|------|--------|----------|
| 0 Discovery + gold fixtures | done | commit 98475143; cohorts 26/26/11/16; 40mail unknown |
| 1 Force Automate + urgent clear | done_pending_review | commit fda24f42; vitest 30 pass; mail-triage untouched |
| 2 Force spam | done | commit pending review |
| 3 Quarantine label + spam-scoped nav | done | see Task 3 note below |
| 4 Quality + re-backfill (Wave B) | blocked_until_fence | |
| Fence monitor armed | pending_after_0_3 | |

## Notes

- Sibling wrasse `feat/centurion-link-precision` owns EC2 tonight.
- Do not edit wrasse worktree.

## Task 3 — U3 design-plan disposition (APPROVED)

**Decision:** APPROVED — Quarantine My Folder routes `folder=spam` + `labelIds`; not archive-like; spam list chrome (`spam_at` truth, not archive + `spam_at IS NULL`).

**Rationale:** R16 keeps `spam_at` sole spam truth. FortiMail digests get ensure-by-name `Quarantine` label on apply (same txn as `spam_at`). FE reserved label IDs from `buildReservedSpamLabelIdSet(userLabels)` wire through `resolveMailRouteFilter`, `isArchiveLikeMailFolder`, `buildThreadFilingSnapshots`, `thread-display` spam chrome. Normal My Folder UUIDs stay archive+labelIds.

**Tests:** mail `search-filter-contract` + `thread-actions-contract` green (20). server apply tests written; skip without disposable DB (5 skipped).
