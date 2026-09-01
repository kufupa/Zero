# Centurion Task 8 — Seed + durable workflow apply

## Status

**DONE_WITH_CONCERNS** — code/tests/typecheck green; disposable DB unavailable, so DB cases remain guarded skips.

## Changes

- Expanded server managed categories to legacy primaries + all 11 workflow primaries + `urgent`; legacy rows remain seeded/readable during dual-read.
- Added idempotent workflow seed rows with workflow-order sort values. Existing `seedAll` upsert loop consumes the expanded seed catalog; no seed migration or legacy-row deletion added.
- Centralized durable primary scan across legacy + workflow slugs.
- `applyDurableTriageResult` accepts workflow output, keeps settled threads `urgency_only`, preserves spam lock/block precedence, and only clears `spam_at` on existing unsettled/exception paths.
- Added independent `workflowTriageEnabled` seam. Worker passes `WORKFLOW_TRIAGE_V6`; off keeps legacy category joins, on writes workflow joins. `AI_WRITE_GATE_ENABLED` remains required. `WORKFLOW_NAV_V6` untouched.
- Added focused seed/gate/apply tests; no dashboard, backfill, or nav flip work.

## TDD evidence

Baseline characterization (before Task 8 edits; safety env unset):

```text
3 files passed; 42 passed; 23 DB-gated tests skipped
```

RED:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/task-8-workflow-durable-apply.test.ts
# 1 static seed test failed; 1 DB-gated apply test skipped
```

GREEN/final focused run:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run \
  tests/task-8-workflow-durable-apply.test.ts \
  tests/categories-contract.test.ts \
  tests/ai-triage-contract.test.ts \
  tests/seed-contract.test.ts \
  tests/ai-worker-contract.test.ts
# 5 files passed; 67 passed; 37 skipped
```

No `TEST_DATABASE_URL`/disposable Postgres or Docker DB was available. Pilot RDS was not touched; no `VITEST_ALLOW_PILOT_RDS` used.

## Verification

- `pnpm --filter @zero/server exec tsc --noEmit --pretty false -p tsconfig.json` — pass.
- `pnpm --filter @zero/server build` — pass.
- `git diff --check` passes on LF-owned paths; category contract retains its pre-existing CRLF line endings (`git diff --ignore-space-at-eol` scoped diff clean).

## Files

- `apps/server-pilot/src/ai/categories.ts`
- `apps/server-pilot/src/ai/triage.ts`
- `apps/server-pilot/src/ai/worker.ts`
- `apps/server-pilot/tests/categories-contract.test.ts`
- `apps/server-pilot/tests/task-8-workflow-durable-apply.test.ts`
- `.superpowers/sdd/centurion-task-8-report.md`
