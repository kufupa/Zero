---
title: Compose close draft honesty — autosave races, lying dialog, cache flush
date: 2026-07-26
category: logic-errors
module: apps/mail compose
problem_type: logic_error
component: email_processing
symptoms:
  - "Stay/Leave dialog warns changes will be lost when autosave already persisted or would persist the draft"
  - "Silent data loss or incomplete flush when switching threads with a dirty reply composer"
  - "Save draft hung awaiting invalidateQueries(listThreads) instead of completing"
  - "Save failed with Postgres unique constraint mail_draft_one_active_thread_uidx when draftId was omitted"
  - "Discard left stale mail.get cache after optimistic draft delete"
root_cause: async_timing
resolution_type: code_fix
severity: high
tags:
  - compose-close
  - draft-autosave
  - thread-switch
  - cache-invalidation
  - race-condition
  - EC2-pilot
  - playwright-ae
related_components:
  - database
  - testing_framework
---

# Compose close draft honesty — autosave races, lying dialog, cache flush

## Problem

Hotel staff use the mail UI like Outlook: reply in-thread, switch threads, close compose. Close behavior was dishonest — a lying Stay/Leave "changes will be lost" prompt when autosave already (or would) persist the draft, silent loss of dirty reply body on thread switch, and no clear Save draft / Discard / Keep editing choice. Feature work plus overnight live-pilot AE exposed hung Save, duplicate-draft Postgres errors, and discarded body still hydrating from cache.

## Symptoms

- Misleading Stay/Leave dialog even when draft was already autosaved or would save on leave
- Typed reply lost when clicking another thread without an explicit close dialog
- Save draft hung; AE Save path timed out under pilot load
- Server: `PostgresError: duplicate key value violates unique constraint "mail_draft_one_active_thread_uidx"` when `drafts.create` ran without `draftId` while an active thread draft existed
- Discard closed composer but discarded text reappeared from `mail.get` `latestDraft`
- Playwright AE flaky: overlays / recipient chips intercepted pointer clicks

## What Didn't Work

- **Awaiting query invalidation after save.** `await Promise.all([queryClient.invalidateQueries(...)])` in `saveDraft` tied Save/flush resolution to `listThreads` / `drafts.list` refetch — UI hung under pilot load.
- **Blind INSERT without URL `draftId`.** Reply opened with `mode` set but no `draftId`; create hit one-active-draft-per-thread unique index and failed.
- **Optimistic delete without `mail.get` invalidation.** Server delete deferred behind undo toast; thread view rehydrated discarded `latestDraft`.
- **Navigate before flush.** `setThreadId` ran before compose flush finished — race dropped unsaved editor state.
- **Standard Playwright `.click()` on pilot.** Radix overlays and sticky UI intercepted pointer events.
- **Prior open-thread poll alone** (session history): aligning `useThread` poll with list poll fixed stale **read** panes, not composer flush on thread switch — do not treat open-thread poll as compose-close fix.
- **Out of scope (deferred):** create-email DialogClose bypass; pop-out; autosave settings UI; non-`en` locale keys; AI candidate mass-discard redesign.

## Solution

### 1. Honest close decision + dialog

Pure helpers decide silent close, silent flush, or prompt:

```typescript
export function resolveComposeCloseAction(
  input: PersistDecisionInput & { intent: ComposeCloseIntent },
): ComposeCloseAction {
  const { intent, ...persistInput } = input;
  if (!shouldPersistDraft(persistInput)) return 'closeSilent';
  if (intent === 'threadSwitch') return 'flushAndLeave';
  return 'prompt';
}
```

- Empty composer → `closeSilent`
- Explicit close with meaningful content → Radix **Keep editing / Save draft / Discard**
- Thread switch with dirty reply → `flushAndLeave` (autosave, no dialog)

### 2. Compose leave flush before navigation

Registry lets list/thread navigation flush the mounted composer before clearing URL state. Mail list and thread display both `await runComposeLeaveFlush(...)` **before** `setThreadId` / clearing compose params.

### 3. Fire-and-forget invalidations after save

```typescript
// Do not await refetch — Save / flush-on-leave must resolve after create,
// not after listThreads/drafts.list refetch.
void Promise.all([
  queryClient.invalidateQueries({ queryKey: trpc.drafts.list.queryKey() }),
  // Scoped mail.get({ id: threadId }) when threadId set; drafts.get; listThreads …
]);
```

Invalidate `drafts.list`, scoped `mail.get` for the thread, `drafts.get`, and `listThreads` — all fire-and-forget.

### 4. Server upsert + bind URL `draftId`

On Postgres unique violation for one active draft per thread, `drafts.create` UPDATEs the existing active row and returns its id. Unique-violation recovery updates the active row only; no revision row on that path (normal INSERT still writes a revision). Reply composer binds `latestDraft.id` into URL `draftId` when mode is set so subsequent saves UPDATE.

### 5. Invalidate `mail.get` after draft delete

After optimistic draft delete executes:

```typescript
await Promise.all([
  queryClient.invalidateQueries({ queryKey: trpc.drafts.list.queryKey() }),
  queryClient.invalidateQueries({ queryKey: trpc.mail.get.queryKey() }),
  queryClient.invalidateQueries({ queryKey: trpc.drafts.get.queryKey({ id: draftId }) }),
]);
```

### 6. AE gate on live pilot

`apps/mail/tests/e2e/real-mail-compose-close-honesty.spec.ts` — Escape overlays, native DOM `.evaluate` clicks, Reply bar + `r` hotkey fallback. AE1–AE4 green on pilot after deploy.

## Why This Works

- Dialog only when `shouldPersistDraft` says content is worth saving; thread switch autosaves instead of lying or dropping.
- Flush completes while the editor is still mounted, before URL/thread state clears.
- Mutation success is the Save contract; cache refetch is background best-effort.
- DB unique index + upsert + client `draftId` binding keep one active row per thread.
- Discard must invalidate every query that hydrates draft body (`mail.get`, not only `drafts.list`).

## Prevention

- Never `await invalidateQueries` on save or leave-flush path — use `void Promise.all([...])`.
- Bind `draftId` to `latestDraft.id` before first save in reply composer; server `create` upserts on unique violation.
- Always invalidate `trpc.mail.get` alongside `drafts.*` on draft delete.
- Always `await` compose leave flush before changing `threadId` or clearing compose URL state.
- Regress with AE `real-mail-compose-close-honesty.spec.ts` plus vitest: `draft-persistence`, `compose-flush-registry`, `reply-compose-context`, `stale-draft-send-flow`.
- Do not conflate **Honesty UI** (hide fake chrome) with compose-close Save/Discard/Keep editing (session history).

## Related Issues

- [Mail draft refresh / refetch clobber / lifecycle](mail-draft-refresh-data-loss-and-lifecycle.md) — foundation (`shouldPersistDraft`, dirty-state); moderate overlap, different problem angle (refetch clobber vs close/navigate honesty)
- [Open-thread stale + recipient You label](mail-open-thread-stale-and-recipient-you-label.md) — `mail.get` cache on thread switch (read path)
- [Live pilot production parity / real-mail](../architecture-patterns/live-pilot-production-parity-real-mail.md) — AE gate harness pattern
- [Playwright E2E EC2 pilot UI gate](../test-failures/playwright-e2e-ec2-pilot-ui-gate.md) — gate infra
- Plan / handoff: `docs/superpowers/plans/2026-07-24-compose-close-draft-honesty.md`, `docs/superpowers/plans/handoff-reports/2026-07-24-compose-close-draft-honesty.md`

**Key commits:** `b7a586c2`, `2969d71a`, `2d3090ad`, `d0569cb9`, `21967853`, `33b13878`, `eba59d61`, `5ce64288` (+ AE gate commits). Verified vitest + Playwright AE1–AE4; ops-deploy @ `5ce64288`.
