---
title: Mail draft loses user-typed reply on refresh, refetch clobber, and stale send
date: 2026-07-07
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
  - stale-draft
  - promotion-race
  - trpc
---

# Mail draft loses user-typed reply on refresh, refetch clobber, and stale send

## Problem
The pilot compose/reply flow could silently lose a user's typed email. Autosave
only fired when recipients **and** subject **and** body all existed, so
body-first drafts were never saved; and when server draft data arrived after the
editor mounted, it overwrote whatever the human had just typed. On top of that,
replies could be sent against stale thread context, and concurrent editor opens
could create duplicate active drafts.

## Symptoms
- Type a reply → refresh → **body gone** (never persisted because recipient/subject were empty).
- Type after load → a late `drafts.get`/`mail.get` refetch **clobbers** the editor with older server content.
- Reopen a live Drafts row → opens **blank standalone compose**, losing `threadId` / `replyToMessageId`.
- Send after a newer inbound message → **stale reply**, no confirmation.
- Double-click "reply" / two tabs → **duplicate active draft** or unique-active-index violation.

## What Didn't Work
- **All-or-nothing autosave guard** (`if (!to || !subject || !body) return;`) — the most common draft (body typed first) never hit the save path, so there was nothing to restore.
- **Trusting the last write to win on refetch** — hydrating the editor from server data whenever it arrived meant a slow query silently replaced fresh human edits.
- **Client-only stale detection** — the frontend cannot reliably know a newer inbound message landed after the draft's parent; the parent linkage has to be server-enforced.
- **Read-then-promote without a transaction** — leaving promotion non-atomic let concurrent editor opens race into two active drafts.

## Solution
Pure, testable helpers plus server-enforced lifecycle. Frontend split into
`apps/mail/lib/mail/draft-persistence.ts`:

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

// Dirty-state protection: local edits win over late server data.
export function chooseDraftEditorState(input: DraftEditorStateInput) {
  if (input.isDirty) {
    return { html: input.localHtml, subject: input.localSubject, source: 'local-dirty' as const };
  }
  return {
    html: input.serverDraft?.content ?? input.localHtml,
    subject: input.serverDraft?.subject ?? input.localSubject,
    source: 'server' as const,
  };
}

// Stale-send: detect server CONFLICT and retry only on explicit confirm.
export function isStaleDraftConflict(error: unknown): boolean {
  const e = error as { data?: { code?: string }; message?: string };
  return e.data?.code === 'CONFLICT' && e.message === 'STALE_DRAFT';
}
export function getStaleDraftRetryInput<T extends object>(input: T): T & { confirmStaleDraft: true } {
  return { ...input, confirmStaleDraft: true };
}
```

Wiring:
- `email-composer.tsx` autosave now gates on `shouldPersistDraft` and builds the mutation via `buildDraftMutationInput` (carries `threadId` + `replyToMessageId`), storing the server-returned `id` back into `draftId` so partial drafts get a real server row early.
- Reply composer passes `replyToMessageId={replyToMessage?.id ?? null}` — the linkage the backend needs for stale checks.
- On draft data arrival, `chooseDraftEditorState` keeps local dirty state instead of overwriting.
- `mail-list.tsx` reopen restores `reply` mode + `replyToMessageId` when the row has a `threadId`.
- After every create/update/send/delete, invalidate `drafts.get`, `drafts.list`, `mail.get(threadId)`, and `mail.listThreads` so folder counts and thread draft indicators don't drift.

Server (`apps/server-pilot`):
- `mail_draft` gains `status` (`active | candidate | discarded | sent`), `origin` (`manual | ai`), `replyToMessageId`, `generationId`.
- Send raises `TRPCError({ code: 'CONFLICT', message: 'STALE_DRAFT' })` when a newer inbound message exists after the draft's `replyToMessageId`; frontend retries only with `confirmStaleDraft: true`.
- `drafts.ensureEditableForReply({ threadId, replyToMessageId })` is **atomic**: existing active draft wins; otherwise the newest candidate for the same parent promotes in place and older sibling candidates become `discarded`. This makes editor-open idempotent under double-click / two tabs.

## Why This Works
The data loss had two independent logic bugs, both fixed at the source:
1. **Save gate too strict** — persistence must key off "the human changed something worth keeping" (`shouldPersistDraft`), not "the message is fully addressed." Body-first is the normal case.
2. **Refetch clobber** — a refetch must never win over unsaved local edits; dirty-state is the tiebreaker (`chooseDraftEditorState`).

Stale correctness and the promotion race are server-owned because only the
backend sees the authoritative thread timeline and can serialize concurrent
opens in one transaction. Pushing those decisions to the client is why earlier
attempts leaked wrong-context sends and duplicate drafts.

## Prevention
- **Extract editor persistence decisions into pure functions** and unit-test them (`draft-persistence.test.ts`, `stale-draft-send-flow.test.ts`, `compose-draft-ownership-contract.test.ts`) — the data-loss logic must be provable without a browser.
- **Never let a refetch overwrite a dirty editor.** Make dirty-state the explicit tiebreaker anywhere server data hydrates a live input.
- **Persist on meaningful change, not on completeness.** Guard autosave on "changed + non-empty", not "all required fields present".
- **Make editor-open mutations idempotent and atomic** on the server (single transaction, unique active index) so double-click / multi-tab can't duplicate.
- **Enforce stale checks server-side** with an explicit `confirmStaleDraft` retry; the client only detects the `CONFLICT` and asks the user.
- **Invalidate every derived view** (drafts list, thread drafts, list indicators) after draft writes so counts don't drift up to `staleTime`.

## Recurrence: typing kick-out after successful autosave (2026-08-04)

Verified recurrence of the refetch-clobber class, with a sharper ownership bug:

- **"Dirty" ≠ "locally owned."** Clearing `hasUnsavedChanges` after a save must not grant the server permission to rewrite an editor that already has a local edit history. Hydration now keys off lifetime local ownership (`localRevision > 0` / `hasLocalEdits`), not current dirty alone.
- **Save acknowledgement covers only its captured revision.** A monotonic `reduceDraftRevision` ledger advances `savedRevision` only for the revision snapshotted before the first await; edits during flight stay dirty and queue a follow-up save.
- **Successful autosave never grants same-ID refetch rewrite rights** on an edited mount. `chooseDraftEditorState({ hasLocalEdits: true })` keeps local HTML/subject even when dirty is false.
- **Persistence ID ≠ React mount identity.** New-mail first create must not swap the composer for a loader or change `key` when `draftId` appears; spinner waits only on mount-time draft intent (`initialDraftIdRef`).
- **Snapshot before attachment serialization; serialize saves.** Capture revision + raw fields before `serializeFiles`; at most one in-flight draft mutation per mount; autosave is single-shot, terminal actions drain via `flushDraftUntilCurrent`. Failed autosave suppresses automatic retry until the next local edit.

## Related
- [fe-pilot-trpc-wire-contract-drift.md](../integration-issues/fe-pilot-trpc-wire-contract-drift.md) — FE↔server-pilot contract drift that the draft `drafts[]` / `ParsedDraft` wire shape resolves
- `docs/superpowers/plans/2026-07-06-server-pilot-contract-convergence-sdd.md` — Task 6/7 (draft lifecycle + AI promotion contract) and Task 9 (refresh-safe draft persistence)
- `docs/superpowers/plans/2026-08-04-compose-typing-kick-out.md` — revision ownership + mount stability fix for typing kick-out
