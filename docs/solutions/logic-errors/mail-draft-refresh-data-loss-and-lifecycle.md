---
title: Mail draft loses user-typed reply on refresh, refetch clobber, and stale send
date: 2026-07-07
last_updated: 2026-08-20
module: apps/mail draft compose + apps/server-pilot drafts router
problem_type: logic_error
component: frontend_stimulus
severity: critical
related_components:
  - email_processing
  - database
symptoms:
  - "User types a reply, refreshes or navigates, and the draft body is gone"
  - "Partial drafts (body typed but no recipient/subject yet) are never persisted server-side"
  - "A late drafts.get / mail.get refetch overwrites the editor with older server content, wiping in-progress edits"
  - "Typing kick-out: continuous typing through autosave replaces recent text with an older saved body"
  - "Typing kick-out: open-thread refetch blanks emailData / shows skeleton and unmounts ReplyCompose mid-type"
  - "Escape after autosave silently closes compose despite nonempty body (no leave prompt)"
  - "New-mail first draftId remounts the composer (spinner / key change), discarding in-progress edits"
  - "Reopening a Drafts-folder row loses thread/reply context (opens as blank standalone compose)"
  - "Sending a reply after a newer inbound arrived answers stale context with no warning"
  - "Two editor opens (double-click / two tabs) race into duplicate active drafts or a unique-index violation"
root_cause: logic_error
resolution_type: code_fix
tags:
  - mail-draft
  - autosave
  - data-loss
  - refresh-safe
  - dirty-state
  - local-ownership
  - typing-kick-out
  - revision-ledger
  - composer-remount
  - thread-open-stability
  - escape-close
  - stale-draft
  - promotion-race
  - trpc
---

# Mail draft loses user-typed reply on refresh, refetch clobber, and stale send

## Problem
The pilot compose/reply flow could silently lose a user's typed email. Autosave
only fired when recipients **and** subject **and** body all existed, so
body-first drafts were never saved; and when server draft data arrived after the
editor mounted, it overwrote whatever the human had just typed. A later
recurrence ("typing kick-out") showed the same ownership class of bug after a
*successful* autosave: clearing the dirty flag handed the live editor back to
stale server HTML, and new-mail first `draftId` remounted the composer mid-type.
On top of that, replies could be sent against stale thread context, and
concurrent editor opens could create duplicate active drafts.

## Symptoms
- Type a reply → refresh → **body gone** (never persisted because recipient/subject were empty).
- Type after load → a late `drafts.get`/`mail.get` refetch **clobbers** the editor with older server content.
- Type continuously through the 3s autosave → recent characters jump back to an older saved body (typing kick-out).
- Type continuously → open-thread refetch / false mismatch → **compose exits** (skeleton / `ReplyCompose` unmount) and remount wipes ownership (2026-08-20).
- Escape after autosave → silent close despite nonempty body (2026-08-20).
- New mail → first autosave assigns `draftId` → spinner / remount → caret and text gone.
- Reopen a live Drafts row → opens **blank standalone compose**, losing `threadId` / `replyToMessageId`.
- Send after a newer inbound message → **stale reply**, no confirmation.
- Double-click "reply" / two tabs → **duplicate active draft** or unique-active-index violation.

## What Didn't Work
- **All-or-nothing autosave guard** (`if (!to || !subject || !body) return;`) — the most common draft (body typed first) never hit the save path, so there was nothing to restore.
- **Trusting the last write to win on refetch** — hydrating the editor from server data whenever it arrived meant a slow query silently replaced fresh human edits.
- **Guarding only current dirty** — after a save cleared `hasUnsavedChanges`, same-ID refetch was allowed to `setContent` over an editor that still had a longer local history. Dirty ≠ owned.
- **Removing the dynamic React `key` alone** — the `isDraftLoading` branch already unmounted the editor for a spinner when the first autosave ID appeared.
- **Blaming AI streaming / autocomplete** — generation applies only on Accept; ghost autocomplete is decoration until Tab.
- **Client-only stale detection** — the frontend cannot reliably know a newer inbound message landed after the draft's parent; the parent linkage has to be server-enforced.
- **Read-then-promote without a transaction** — leaving promotion non-atomic let concurrent editor opens race into two active drafts.

## Solution
Pure, testable helpers plus server-enforced lifecycle. Frontend decisions live in
`apps/mail/lib/mail/draft-persistence.ts` and are wired from
`apps/mail/components/create/email-composer.tsx` / `create-email.tsx`.

```ts
// Persist body-first drafts; skip unchanged or AI-transient content.
export function shouldPersistDraft(input: PersistDecisionInput): boolean {
  if (!input.hasUnsavedChanges || input.aiBlocked) return false;
  if (input.html.trim() === input.initialHtml.trim()) return false;
  return (
    input.text.trim().length > 0 ||
    input.subject.trim().length > 0 ||
    input.to.length > 0
  );
}

// Lifetime ownership: once any local edit exists on this mount, server cannot win.
export function chooseDraftEditorState(input: DraftEditorStateInput) {
  if (input.hasLocalEdits) {
    return {
      html: input.localHtml,
      subject: input.localSubject,
      source: 'local-dirty' as const,
    };
  }
  return {
    html: input.serverDraft?.content ?? input.localHtml,
    subject: input.serverDraft?.subject ?? input.localSubject,
    source: 'server' as const,
  };
}

// Monotonic revision ledger: a save acks only the revision it captured.
export function reduceDraftRevision(
  state: DraftRevisionState,
  event: DraftRevisionEvent,
): DraftRevisionState {
  if (event.type === 'edited') {
    return { ...state, localRevision: state.localRevision + 1 };
  }
  return {
    ...state,
    savedRevision: Math.max(state.savedRevision, event.capturedRevision),
  };
}
```

Wiring:
- Hydration passes `hasLocalEdits: revisionRef.current.localRevision > 0` (not current dirty).
- `persistDraftOnce` joins via `saveInFlightRef`, snapshots revision + raw fields **before** any `await` (including `serializeFiles`), acknowledges only `capturedRevision`, mirrors dirty from `localRevision > savedRevision`, and suppresses automatic autosave retry after failure until the next local edit.
- Terminal actions drain with `flushDraftUntilCurrent`; autosave is single-shot.
- Send uses `draftId: activeDraftIdRef.current` (parents consume `data.draftId`) and clears with `clearContent(false)`.
- New mail: `initialDraftIdRef` / `shouldWaitForInitialDraft` — only mount-time draft intent shows the loader; drop `key={typedDraft?.id`.
- Reply composer passes `replyToMessageId={replyToMessage?.id ?? null}`.
- After create/update/send/delete, invalidate `drafts.get`, `drafts.list`, `mail.get(threadId)`, and `mail.listThreads`.

Server (`apps/server-pilot`):
- `mail_draft` gains `status` (`active | candidate | discarded | sent`), `origin` (`manual | ai`), `replyToMessageId`, `generationId`.
- Send raises `TRPCError({ code: 'CONFLICT', message: 'STALE_DRAFT' })` when a newer inbound message exists after the draft's `replyToMessageId`; frontend retries only with `confirmStaleDraft: true`.
- `drafts.ensureEditableForReply({ threadId, replyToMessageId })` is **atomic**: existing active draft wins; otherwise the newest candidate for the same parent promotes in place and older sibling candidates become `discarded`. This makes editor-open idempotent under double-click / two tabs.

## Why This Works
The data loss had independent logic bugs, fixed at the source:
1. **Save gate too strict** — persistence must key off "the human changed something worth keeping" (`shouldPersistDraft`), not "the message is fully addressed." Body-first is the normal case.
2. **Refetch clobber** — a refetch must never win over *owned* local edits. Ownership is lifetime (`hasLocalEdits` / `localRevision > 0`), not the transient dirty flag.
3. **Stale save acknowledgement** — acknowledging only the captured revision keeps in-flight edits dirty and queues a serialized follow-up save; an older response cannot clear newer local history.
4. **Mount identity ≠ persistence ID** — minting a draft ID must not unmount or re-key the live editor.

Stale correctness and the promotion race are server-owned because only the
backend sees the authoritative thread timeline and can serialize concurrent
opens in one transaction. Pushing those decisions to the client is why earlier
attempts leaked wrong-context sends and duplicate drafts.

## Prevention
- **Extract editor persistence decisions into pure functions** and unit-test them (`draft-persistence.test.ts`, `stale-draft-send-flow.test.ts`, `compose-draft-ownership-contract.test.ts`) — the data-loss logic must be provable without a browser.
- **Dirty ≠ owned.** Never gate hydration on a transient unsaved flag alone; use lifetime local ownership.
- **Acknowledge only the captured revision.** Snapshot before the first `await` (including attachment serialization); never blanket-clear dirty after save.
- **Serialize saves** (`saveInFlightRef` join) and keep the returned draft ID in a synchronous ref.
- **Persistence ID ≠ React mount identity.** Only mount-time draft intent may show the initial loader.
- **Persist on meaningful change, not on completeness.** Guard autosave on "changed + non-empty", not "all required fields present".
- **Make editor-open mutations idempotent and atomic** on the server (single transaction, unique active index) so double-click / multi-tab can't duplicate.
- **Enforce stale checks server-side** with an explicit `confirmStaleDraft` retry; the client only detects the `CONFLICT` and asks the user.
- **Invalidate every derived view** (drafts list, thread drafts, list indicators) after draft writes so counts don't drift up to `staleTime`.
- **Never resolve open-thread identity with a message-id fallback**; blank UI only on positive thread-id mismatch; keep prior `mail.get` payload across refetch (`placeholderData: (previousData) => previousData`).
- **Do not skeleton-unmount a loaded thread/composer solely because `isFetching`.**
- **Escape after autosave** must consider nonempty text/subject/to, not dirty alone; ignore Escape while IME `isComposing`.

## Recurrence: typing kick-out after successful autosave (2026-08-04 / 2026-08-06)

Verified recurrence of the refetch-clobber class, with a sharper ownership bug.
Plan: `docs/superpowers/plans/2026-08-04-compose-typing-kick-out.md`. Shipped on
`EC2-pilot` (pilot SPA rebuild via `ops-deploy`).

- **"Dirty" ≠ "locally owned."** Clearing `hasUnsavedChanges` after a save must not grant the server permission to rewrite an editor that already has a local edit history. Hydration keys off lifetime ownership (`localRevision > 0` / `hasLocalEdits`).
- **Save acknowledgement covers only its captured revision.** `reduceDraftRevision` advances `savedRevision` only for the revision snapshotted before the first await; edits during flight stay dirty and queue a follow-up save.
- **Successful autosave never grants same-ID refetch rewrite rights** on an edited mount.
- **Persistence ID ≠ React mount identity.** New-mail first create must not swap the composer for a loader or change `key` when `draftId` appears (`initialDraftIdRef`).
- **Snapshot before attachment serialization; serialize saves.** Failed autosave suppresses automatic retry until the next local edit (`autosaveSuppressedAfterFailure`).

## Recurrence: open-thread unmount + Escape silent close (2026-08-20)

Ownership ledger still protects a **mounted** editor. A later recurrence wiped text **and exited compose** because the mount itself died, then Escape silent-closed nonempty drafts after autosave cleared dirty.

Shipped on branch `fix/mail-compose-typing-kick-out-unmount` (commit reachable on that branch / EC2 pilot deploy as of 2026-08-20; not on `origin/main` yet — cite the branch, not a permanent SHA).

### What failed

- Open-thread id used `latest.threadId ?? latest.id` (message-id fallback) → false `isThreadDataMismatch` → blanked `emailData` → skeleton / `ReplyCompose` `return null` unmounted mid-type; remount reset `revisionRef` so ownership no longer applied.
- `placeholderData: undefined` dropped prior `mail.get` payload on query churn.
- Skeleton rule `!emailData || isLoading || (isFetching && isThreadDataMismatch)` tore down a loaded thread during same-thread refetch.
- Document capture Escape called generic `handleClose` → after autosave cleared dirty, `closeSilent` despite nonempty body/subject/to. Letter hotkeys (`e`/`r`/…) are blocked on contenteditable by default; Escape was the real shortcut path.

### Fix

Pure helpers in `apps/mail/lib/mail/thread-open-stability.ts`, wired from `use-threads.ts`, `thread-display.tsx`, `email-composer.tsx`:

- `resolveOpenThreadId` — prefer response/thread id; **never** fall back to message id.
- `shouldBlankOpenThreadData` — blank only on positive mismatch; unknown resolved id keeps data.
- `shouldShowOpenThreadSkeleton` — do not unmount a loaded thread on same-thread refetch.
- `resolveComposeEscapeAction` — ignore IME `isComposing`; prompt when text/subject/to remain after dirty cleared.

Tests: `apps/mail/tests/thread-open-stability.test.ts`, `apps/mail/tests/compose-typing-kick-out-unmount-contract.test.ts`.

When investigating “typing kick-out,” check **remount/unmount and Escape** before assuming only server-refetch `setContent` clobber.

## Related
- [compose-close-draft-honesty.md](./compose-close-draft-honesty.md) — leave/close flush honesty; shares `shouldPersistDraft` helpers; Escape prompt policy overlaps this doc’s 2026-08-20 recurrence
- [mail-open-thread-stale-and-recipient-you-label.md](./mail-open-thread-stale-and-recipient-you-label.md) — inverse React Query failure (under-refetch); open-thread poll feeds the refetch surface that 2026-08-20 hardened
- [mail-close-empty-pane-mid-width.md](../ui-bugs/mail-close-empty-pane-mid-width.md) — thread-panel mount gating (shell), distinct from compose unmount mid-type
- [fe-pilot-trpc-wire-contract-drift.md](../integration-issues/fe-pilot-trpc-wire-contract-drift.md) — FE↔server-pilot contract drift that the draft `drafts[]` / `ParsedDraft` wire shape resolves
- `docs/superpowers/plans/2026-07-06-server-pilot-contract-convergence-sdd.md` — Task 6/7 (draft lifecycle + AI promotion contract) and Task 9 (refresh-safe draft persistence)
- `docs/superpowers/plans/2026-08-04-compose-typing-kick-out.md` — revision ownership + mount stability fix for typing kick-out
- Branch `fix/mail-compose-typing-kick-out-unmount` — open-thread stability + Escape kick-out fix (pilot deploy 2026-08-20; not yet on `origin/main`)