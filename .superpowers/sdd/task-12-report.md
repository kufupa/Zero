# Task 12 Report — Replace Label-Based Folder Moves with State Actions

**Date:** 2026-07-06  
**Branch:** `EC2-pilot`  
**Base:** Task 11 @ `f64b962e`

## Status: PASS (local gate)

## Commits

| Commit | Message |
|--------|---------|
| `4b9585b6` | `feat: inject live category sidebar nav` (Task 11 leftover, separate from Task 12) |
| `498ab5a0` | `feat: align folder move actions with pilot state` |

## What changed

### Schema + migration
- Added `mail_thread.spam_at` column in `apps/server-pilot/src/db/schema/mail.ts`
- Created `apps/server-pilot/drizzle/0007_mail_thread_spam_state.sql` with backfill from legacy `SPAM` label + index `mail_thread_transport_spam_idx`

### Backend (`mail.ts`)
- Added `moveThreadsInput` + `moveThreads` mutation — patches `isArchived`, `trashedAt`, `spamAt`, `snoozedUntil` per destination
- `listThreads` spam folder now filters `spam_at IS NOT NULL`; all other folders exclude `spam_at IS NOT NULL`
- Removed SPAM-label-based inbox/spam folder filtering

### Ingest (`store.ts`)
- Direct-to fallback spam path sets `spamAt` on thread (keeps SPAM label for backfill compat)

### Frontend (`thread-actions.ts`)
- `moveThreadsTo` calls `trpcClient.mail.moveThreads.mutate` instead of `modifyLabels` for inbox/archive/spam/bin

## Tests

| Gate | Result |
|------|--------|
| `pnpm --filter=@zero/mail test -- thread-actions-contract` | **PASS** (1 test) |
| `pnpm vitest run tests/mail-thread-actions.test.ts` | **SKIP** (7 tests — no local RDS; `TEST_DB_AVAILABLE` false) |
| `pnpm vitest run tests/schema-contract.test.ts` | **PASS** (8 tests) |

New tests:
- `apps/mail/tests/thread-actions-contract.test.ts` — asserts `moveThreadsTo` uses `moveThreads`, not `modifyLabels`
- `apps/server-pilot/tests/mail-thread-actions.test.ts` — `moves threads between system states without label emulation`

## Interfaces

| Producer | Consumer |
|----------|----------|
| `mail.moveThreads({ threadIds, destination })` | `moveThreadsTo({ threadIds, destination })` |

Spam folder state: `mail_thread.spam_at` (not label mutation).

## Follow-up

- Apply `0007_mail_thread_spam_state.sql` on RDS before deploy
- Re-run `mail-thread-actions` on EC2/VPC with `TEST_DB_AVAILABLE` to verify integration test green
