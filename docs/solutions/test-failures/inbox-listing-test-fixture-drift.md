---
title: EC2 inbox listThreads tests fail after thread-only fixtures
date: 2026-07-06
category: test-failures
module: server-pilot
problem_type: test_failure
component: testing_framework
symptoms:
  - "mail-router-isolation.test.ts inbox list assertions fail on EC2 RDS"
  - "trash-soft-delete.test.ts fails before bulkDelete with thread not in inbox"
  - "Failures resemble transport isolation or trash bugs but isolation get/mutate tests pass"
root_cause: test_isolation
resolution_type: test_fix
severity: medium
tags:
  - inbox-listing
  - listThreads
  - test-fixtures
  - seed-inbox-thread
  - ec2-pilot
related_components:
  - email_processing
---

# EC2 inbox listThreads tests fail after thread-only fixtures

## Problem

After commit `c59fba8e` tightened inbox listing, three EC2 RDS-backed tests failed while the wire gate and most of the suite stayed green. The failures looked like router isolation or trash regressions, but production mail routes were behaving as designed.

## Symptoms

- `mail-router-isolation.test.ts` — `listThreads({ folder: 'inbox' })` sanity checks failed (`thread-frontdesk-1` / `thread-centurion-1` missing)
- `trash-soft-delete.test.ts` — failed at `inboxBefore` assertion before `bulkDelete` ran
- `mail-thread-actions.test.ts` — continued to pass (already seeded inbound messages)
- Wire gate (`fixture-loopback-gate`, `wire-gate`) unaffected

## What Didn't Work

- Treating as transport isolation bug — `get` / `markAsRead` / `bulkArchive` NOT_FOUND tests on centurion threads were not the failing cases; only inbox **list** assertions broke
- Treating as trash/soft-delete bug — `bulkDelete` never reached; thread absent from inbox query first
- Swapping isolation tests to `folder: 'all'` — would hide future inbox-filter regressions; trash test must exercise real inbox path
- Reverting inbox inbound filter — breaks intentional product rule (outbound-only compose threads live in sent, not inbox)

## Solution

1. **Match the inbox invariant in fixtures** — any test calling `listThreads({ folder: 'inbox' })` must seed at least one inbound `message` row per thread (commit `9029781d`).
2. **Centralize in `seedInboxThread`** — `apps/server-pilot/tests/helpers/seed-inbox-thread.ts` inserts thread + inbound message; migrated:
   - `mail-router-isolation.test.ts` (`seedFrontdeskFixture`)
   - `trash-soft-delete.test.ts` (`insertInboxThread`)
   - `mail-thread-actions.test.ts` (`seedActionThread`)

```typescript
// apps/server-pilot/tests/helpers/seed-inbox-thread.ts
await seedInboxThread(db, {
  threadId: 'thread-centurion-1',
  transportId: 'transport-centurion',
  transportEmail: 'centurion@legacyhotel.com',
  subject: 'Centurion booking #4471',
});
```

Production inbox filter (unchanged):

```typescript
// apps/server-pilot/src/trpc/routes/mail.ts — folder === 'inbox'
conditions.push(
  exists(
    db.select({ one: sql`1` }).from(message).where(
      and(
        eq(message.threadId, mailThread.id),
        eq(message.transportId, transportId),
        eq(message.direction, 'inbound'),
      ),
    ),
  ),
);
```

## Why This Works

`c59fba8e` added the inbound-message `EXISTS` clause so outbound-only compose threads appear in **sent** only. Tests that inserted `mail_thread` rows without `message` rows returned empty inbox lists — assertions failed at setup, not at the logic under test. Ingest (`store.ts`) and compose (`mail.send`) always pair threads with messages in production; fixtures must mirror that.

## Prevention

- Use `seedInboxThread` for any new test that asserts on `folder: 'inbox'`
- When changing `listThreads` folder semantics, grep tests for `listThreads.*inbox` and `insert(mailThread)` without matching inbound `message`
- Pair prod inbox-filter changes with fixture updates in the **same commit** (`c59fba8e` only updated `ingest-store.test.ts`)
- Run RDS-backed suite on EC2 after inbox router changes: `pnpm test` with `.env.production`

## Related Issues

- [mail-list-keyset-pagination-cursor.md](../logic-errors/mail-list-keyset-pagination-cursor.md) — pagination cursor bugs on same `listThreads` route
- [nava-fixture-loopback-e2e-harness.md](../architecture-patterns/nava-fixture-loopback-e2e-harness.md) — E2E inbox assertions via real ingest (inherently safe)
- [fe-pilot-trpc-wire-contract-drift.md](../integration-issues/fe-pilot-trpc-wire-contract-drift.md) — folder slug contract for `listThreads`
