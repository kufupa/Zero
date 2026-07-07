---
title: Mail list page-2 keyset cursor fails on postgres.js tuple compare
date: 2026-07-04
category: logic-errors
module: server-pilot mail routes
problem_type: logic_error
component: email_processing
symptoms:
  - "mail.listThreads page 2 returns ERR_INVALID_ARG_TYPE on EC2/RDS"
  - "Inbox first page loads; scrolling past ~50 threads fails or returns empty"
  - "list-pagination.test.ts fails on cursor query with Date in SQL tuple"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags:
  - keyset-pagination
  - mail-list
  - drizzle
  - postgres-js
  - ec2-pilot
  - tier5
related_components:
  - mail-helpers
  - drafts router
---

# Mail list page-2 keyset cursor fails on postgres.js tuple compare

## Problem

After U2 added `DESC NULLS LAST` keyset pagination, the first page of threads and drafts worked, but requesting page 2+ could throw `ERR_INVALID_ARG_TYPE` against RDS. Users with more than one page of mail saw broken infinite scroll.

## Symptoms

- EC2 vitest `list-pagination.test.ts` failed with postgres.js `ERR_INVALID_ARG_TYPE` on the cursor predicate query.
- Serialized error showed parameters included a JavaScript `Date` inside a row-comparison tuple: `(COALESCE(latest_message_at, ...), id) < ($cursorTs, $cursorId)`.
- Page 1 (`limit: 50`, no cursor) succeeded; page 2 with `nextPageToken` failed.

## What Didn't Work

- Assuming page-1 green meant pagination was fine — the bug only appears once a cursor is decoded and bound.
- Treating the eight EC2 server test failures as production regressions — seven were stale test assertions or mocks; only pagination was a real code defect.

## Solution

Bind the cursor timestamp as an ISO string cast to `timestamptz` in SQL instead of passing a raw `Date` object into the drizzle `sql` template tuple.

**Before** (`apps/server-pilot/src/trpc/routes/mail-helpers.ts`):

```typescript
export function keysetBefore(tsColumn: unknown, idColumn: unknown, cursorTs: Date, cursorId: string) {
  return sql`(COALESCE(${tsColumn}, to_timestamp(0)), ${idColumn}) < (${cursorTs}, ${cursorId})`;
}
```

**After** (commit `a8ca9675`):

```typescript
export function keysetBefore(tsColumn: unknown, idColumn: unknown, cursorTs: Date, cursorId: string) {
  const cursorTsIso = cursorTs.toISOString();
  return sql`(COALESCE(${tsColumn}, to_timestamp(0)), ${idColumn}) < (${cursorTsIso}::timestamptz, ${cursorId})`;
}
```

Same helper is used by `mail.listThreads` and `drafts.list` cursor paths.

**Deploy:** bundle sync to `5515befe` + `deploy-ec2.sh`; `list-pagination.test.ts` **3/3 pass** on EC2 after deploy.

## Why This Works

`encodePageCursor` / `decodePageCursor` correctly round-trip ISO timestamps in the token string. The failure was only at SQL bind time: postgres.js does not accept a `Date` inside a parenthesized row literal used for tuple comparison. Casting `toISOString()` to `timestamptz` gives the driver a bindable scalar the planner can compare against `COALESCE(latest_message_at, to_timestamp(0))`.

## Prevention

- Keep `apps/server-pilot/tests/list-pagination.test.ts` in the EC2 full-suite gate (`NODE_ENV=test` + sourced `.env.production`) — it is the cheapest detector for cursor bind regressions.
- When adding keyset helpers, never pass raw `Date`/`Buffer` into `sql` row tuples; use explicit casts (`::timestamptz`, `::uuid`, etc.).
- Smoke manually or via harness: seed >50 threads, fetch page 1, pass `nextPageToken` into page 2, assert disjoint ids.

## Related Issues

- Post-audit Tier 5 plan: `docs/superpowers/plans/2026-07-03-ec2-pilot-post-audit-tier5-plan.md` (U2 introduced NULLS LAST sort; pagination bind fixed in triage commit `a8ca9675`).
- Gate report: `docs/solutions/workflow-issues/ec2-pilot-post-audit-tier5-execution.md`
- Deploy loop: `docs/solutions/workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md`
