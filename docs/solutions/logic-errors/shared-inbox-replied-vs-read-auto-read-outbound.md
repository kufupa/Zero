---
title: Shared inbox replied ≠ read — auto-read on outbound-latest + hasReplied arrow
date: 2026-08-04
last_updated: 2026-08-04
category: logic-errors
module: mail / shared-inbox (Centurion pilot)
problem_type: logic_error
component: email_processing
severity: high
symptoms:
  - "Centurion shared-inbox staff could not tell which threads had been replied to; greying on open mirrored Outlook read but read ≠ replied"
  - "List bold/grey used hasUnread from messages.some(!isRead) via mail.get, so thread is_read alone did not clear the row after reply"
  - "mail.send inserted outbound as isRead true but left prior inbound unread, so the row stayed bold after a real reply"
  - "Hotel-sent ingest always set mail_thread.is_read false, so Outlook/Zimbra outbound copies could make threads look more unread"
  - "Ops backfill against pilot RDS requires an explicit --confirm-pilot-rds gate (refuse without it)"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - tooling
  - database
tags:
  - mail
  - shared-inbox
  - is-read
  - has-unread
  - has-replied
  - hotel-sent
  - centurion
  - auto-read
  - backfill
---

# Shared inbox replied ≠ read — auto-read on outbound-latest + hasReplied arrow

## Problem

Front-office staff on the Centurion shared mailbox could not tell which guest threads had already been answered versus which still needed work. The list UI greys threads when they look “read,” which staff treated as Outlook-style “handled,” but that signal only meant messages were marked read (often from opening the thread). A separate need—“has someone from the hotel already replied?”—was invisible. Worse, after a reply from Nava or Outlook, prior inbound messages could stay unread, so the row stayed bold even though the ball was no longer with the hotel. Hotel-sent copies ingested from Outlook/Zimbra also flipped the thread unread via ingest thread resolution, so answering from Outlook could make a thread look *more* unfinished.

## Symptoms

- Pilot FO asked how to know what was already replied to in the Centurion shared inbox.
- Opening a thread greys it (read styling) without meaning “answered.”
- After sending a reply in Nava, the inbox row could remain bold because unread inbound messages still drove `hasUnread`.
- Replies sent from Outlook (mailbox From → hotel-sent ingest) could leave or reintroduce unread/bold state.
- No persistent, scannable “replied” marker next to list rows (Outlook-style reply arrow).
- After the feature shipped and historical outbound-latest threads were backfilled, the top of a busy Centurion inbox still showed many threads without a reply arrow—those threads simply have no outbound yet (product-expected for an unanswered work queue; reply markers appear further down).

## What Didn't Work

- Treating list grey/bold as “handled.” Grey tracks unread state, not reply state. On `mail.get`, unread for the detail/list enrichment path is `hasUnread = parsedMessages.some((m) => m.unread)` (`apps/server-pilot/src/trpc/routes/mail.ts` ~591), not “someone answered.”
- Relying on thread-level `is_read` alone. List rows expose `isRead` from `mail_thread` via `listThreads` (`mail.ts` ~533), but the FE bold/grey path used for triage is driven by per-message unread aggregated through `mail.get` / `useThread`.
- Inserting the outbound message as `isRead: true` on `mail.send` without clearing prior inbound unread. Before the shared helper, that left `hasUnread` true after a successful reply.
- Expecting ingest of a hotel-sent Outlook copy to look “done.” `resolveThreadId` updates matched threads with `isRead: false` on new activity, including paths that later classify the message as hotel-sent outbound—so without an explicit post-insert mark-read, Outlook replies fought the “ball not with us” UX.
- Looking for `hasReplied` on `listThreads`. That procedure’s return shape does not include `hasReplied`. The list gets the flag only by fetching thread detail per row via `useThread` → `mail.get`.

## Solution

Ship two orthogonal signals and one shared write path:

1. **Ever-replied marker (`hasReplied`)**  
   On `mail.get`, `hasReplied = messages.some((m) => m.direction === 'outbound')` (`mail.ts` ~592, returned ~658). Any outbound (reply or forward) counts.  
   FE: `apps/mail/components/mail/mail-list.tsx` loads detail via `useThread` and shows Lucide `Reply` (`h-3 w-3`) when `!isFolderSent && getThreadData.hasReplied`. Arrow is hidden in Sent.

2. **Auto-read when we answer (outbound transition)**  
   Shared helper `markThreadRead(db, transportId, threadIds)` in `apps/server-pilot/src/mail/thread-read.ts` sets `mail_thread.is_read` and all messages in those threads to read. Call sites:
   - `markAsRead`
   - `mail.send` after outbound insert
   - Hotel-sent ingest after insert (where hotel From sets `direction: 'outbound'`)

3. **Ops backfill for historical outbound-latest unread threads**  
   Script: `apps/server-pilot/scripts/backfill-outbound-latest-read.mjs`. Dry-run is default; `--apply` performs updates. Against pilot RDS (`nava-zero-mail-pilot` in `DATABASE_URL`), both dry-run and apply require `--confirm-pilot-rds`. Prints counts only—no subjects, addresses, or bodies. Operator-observed on Centurion (2026-08-04): 74 threads updated; residual candidates 0 after re-check; Nava 0 candidates (not replayable from repo alone).

Deploy verification (as of 2026-08-04 on `EC2-pilot`): feature landed as `feat(mail): shared-inbox replied marker and auto-read on outbound` (local SHA subject to rewrite on merge — prefer PR number once opened); EC2 Playwright spot-check observed `svg.lucide-reply` after scrolling past unanswered top-of-inbox (session evidence, not a checked-in gate).

Plan of record: `docs/superpowers/plans/2026-08-04-shared-inbox-replied-auto-read.md`.

## Why This Works

- **Direction is source of truth.** `hasReplied` does not invent columns; it mirrors whether an outbound message exists. Guest follow-up stays bold via new unread inbound while the arrow remains (ever-replied).
- **One mark-read path.** Manual mark-as-read, Nava send, and Outlook hotel-sent ingest all clear thread + message unread the same way, so grey means “ball not with us” after we answered—not merely “someone opened it.”
- **Hotel-sent overrides the unread bump.** Even though `resolveThreadId` still sets thread `isRead: false` when attaching to an existing thread, the hotel-sent branch immediately calls `markThreadRead`, restoring the intended post-reply state.
- **List cost stays intentional.** `listThreads` stays lean without `hasReplied`; per-row `useThread` → `mail.get` supplies the arrow.
- **Busy unanswered top-of-inbox is expected.** Many top Centurion threads have no outbound; missing arrows there are not a regression of the marker—they are inbound-only work.

## Prevention

- Do not equate “opened / grey” with “handled” for shared hotel mailboxes. Design for two signals: unread (needs eyes / ball with us) and replied (ever answered).
- Any outbound transition (Nava `mail.send` or hotel-sent ingest) must mark the whole thread read if product grey means “ball not with us.” Prefer `markThreadRead` over ad-hoc single-message `isRead: true`.
- Keep `hasReplied` derived from `direction === 'outbound'`; do not denormalize unless a measured list performance need appears.
- Hide the reply arrow in Sent; any outbound still counts as replied in inbox/other folders.
- Manual Mark unread after a reply may stick until the next inbound or next outbound auto-read—document that as allowed behavior, not a bug.
- **Ops / pilot RDS:** never point Vitest at pilot. For the outbound-latest backfill, default dry-run; use `--apply` only deliberately; against pilot always pass `--confirm-pilot-rds` (required for dry-run and apply). Log counts only—no PII. Re-run dry-run after apply and expect residual `0` before calling the mailbox clean. See also [vitest-production-pilot-db-wipe](../database-issues/vitest-production-pilot-db-wipe.md).
- Tests for this behavior use disposable non-production DBs only (`unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest).

## Related Issues

- Plan: `docs/superpowers/plans/2026-08-04-shared-inbox-replied-auto-read.md`
- Adjacent: [mail-open-thread-stale-and-recipient-you-label](./mail-open-thread-stale-and-recipient-you-label.md) (outbound display, different cause)
- Pilot RDS safety culture: [vitest-production-pilot-db-wipe](../database-issues/vitest-production-pilot-db-wipe.md), [nava-mailbox-switcher-finish-wipe-safe-verify](../workflow-issues/nava-mailbox-switcher-finish-wipe-safe-verify.md)
- Out of v1 (do not invent as fixed): `awaitingUs` wire field, denormalized reply columns, Needs-reply filter, separate forward icon, claim/lock / double-reply locking.
