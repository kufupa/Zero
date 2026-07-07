---
title: Frontend Pilot tRPC Wire Contract Drift
date: 2026-07-02
last_updated: 2026-07-07
category: integration-issues
module: server-pilot trpc
problem_type: integration_issue
component: development_workflow
severity: critical
symptoms:
  - "tRPC 405 METHOD_NOT_SUPPORTED on all queries from apps/mail"
  - "Bulk mutations return BAD_REQUEST due to payload shape drift (ids vs threadIds, folder slugs, mail.send/settings/drafts shapes)"
root_cause: wrong_api
resolution_type: code_fix
tags:
  - trpc
  - wire-contract
  - server-pilot
  - apps-mail
---

# Frontend Pilot tRPC Wire Contract Drift

## Problem

The real `apps/mail` frontend was completely unusable against `server-pilot` even though the pilot test suite reported green. Every inbox load, settings fetch, and thread open failed at the HTTP layer or returned payloads the UI could not parse. The 50-user load gate also passed while never exercising the database read path — giving false confidence that the pilot API was production-ready.

## Symptoms

- Browser network tab shows `POST /api/trpc/mail.listThreads` → **405** `METHOD_NOT_SUPPORTED`.
- After enabling method override, bulk operations → **400** `BAD_REQUEST` because the server expected `threadIds` but the FE sends `ids`.
- `mail.listThreads` rejects folder slugs the FE navigation uses (`bin`, `spam`, `draft`, `archive`).
- `mail.get` returns shapes the FE does not expect (`ParsedMessage` with `sender`, `decodedBody`, `receivedOn`).
- `scripts/load-50-users.ts` counted any non-5xx response as success, so fast 405s inflated pass metrics.

## What Didn't Work

- **Pilot-only unit tests** encoded the drifted contract — asserted `threadIds`, canonical folder enums, server-native shapes, not what `use-optimistic-actions.ts` sends.
- **Load gate with `fiveXx === 0` only.** A 405 is not a 5xx; sub-second 405s counted as healthy probes.
- **Assuming `@zero/server` types match runtime.** `apps/mail` imports types from the legacy Workers router; `server-pilot` implements a different wire format at runtime.

## Solution

### 1. Enable tRPC method override

`apps/mail` sends every tRPC query as POST via `methodOverride: 'POST'` in `query-provider.tsx`. tRPC v11's fetch adapter rejects POST queries unless the server opts in:

```typescript
// apps/server-pilot/src/main.ts
fetchRequestHandler({
  endpoint: '/api/trpc',
  router: appRouter,
  req: c.req.raw,
  allowMethodOverride: true,
  // ...
});
```

### 2. Align wire contracts (bug-fix plan Tasks 2–4)

Introduce `apps/server-pilot/src/trpc/wire-compat.ts` with zod input schemas accepting FE shapes:

- **`bulkIdsInput`** — `{ ids: string[] }` → `{ threadIds }`
- **`snoozeThreadsInput`** — `{ ids, wakeAt }` → `{ threadIds, snoozedUntil }`
- **Folder slugs** — accept `draft`, `archive`, `bin`, `spam` in `listThreads`
- **`sendInput` / `parseFromEmail`** — accept `fromEmail` display string from compose UI
- **`toParsedMessage`** — map DB rows to FE `ParsedMessage` for `mail.get`

Golden tests in `mail-wire-contract.test.ts` copy payloads from `use-optimistic-actions.ts`.

### 3. Fix load script assertions

`load-50-users.ts` must require `res.status === 200` for list/get probes, not merely non-5xx.

## Why This Works

The frontend was built against the legacy `@zero/server` tRPC contract: POST for all queries, `ids` field naming, slug-based folders, rich parsed message objects. `server-pilot` implemented a cleaner internal schema but never adapted the HTTP boundary. Method override fixes transport; wire-compat fixes payloads.

## Prevention

- **Manual smoke after any router change:** login → inbox → thread → star → settings (two minutes).
- **`mail-wire-contract.test.ts`:** golden FE payloads must parse on every CI run.
- **Load gate asserts 200, not merely non-5xx.**
- **Do not trust `@zero/server` type imports as proof of runtime compatibility.** This drift also has a **compile-time cousin**: the `server-pilot` driver types (`ThreadListItem`, `ThreadDetailResponse`, `ParsedMessage`) can omit fields the FE actually consumes (`historyId`, `centurionCategory`, `listUnsubscribe`), which surfaces as a typecheck failure rather than a 405/400. Keep the driver types truthful to what the router actually returns.

## Related Issues

- [false-green-gate-unpersisted-tsc-fixes.md](../workflow-issues/false-green-gate-unpersisted-tsc-fixes.md) — type-level driver-contract drift (missing `historyId`/`centurionCategory`/`listUnsubscribe`) as one bucket of a `tsc` regression; the compile-time counterpart to this runtime drift.
- [2026-07-02-ec2-pilot-bug-hunt.md](../../superpowers/plans/2026-07-02-ec2-pilot-bug-hunt.md)
- [2026-07-02-ec2-pilot-bug-fixes.md](../../superpowers/plans/2026-07-02-ec2-pilot-bug-fixes.md) (implementation plan — may be in progress)
