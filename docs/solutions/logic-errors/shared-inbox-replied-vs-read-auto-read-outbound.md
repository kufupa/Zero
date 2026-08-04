---
title: Shared inbox replied ≠ read — auto-read on outbound-latest
date: 2026-08-04
category: logic-errors
tags: [mail, shared-inbox, isRead, hasUnread, hotel-sent, centurion]
---

# Shared inbox replied ≠ read — auto-read on outbound-latest

## Symptom

Pilot FO asked how to know what was replied to in the Centurion shared inbox. Greying on open looked like Outlook “read,” but did not mean “someone answered the guest.” Replies from Outlook could even make threads look *more* unread.

## Root cause

1. List grey/bold uses `mail.get` `hasUnread = messages.some(m => !m.isRead)`, not thread `is_read` alone.
2. `mail.send` inserted outbound `isRead: true` but left prior inbound messages unread → row stayed bold after reply.
3. Ingest `resolveThreadId` always set `mail_thread.is_read = false`, including hotel-sent (mailbox From) copies from Outlook/Zimbra.

## Fix

- Shared `markThreadRead(db, transportId, threadIds)` marks thread + all messages read.
- Call from `markAsRead`, `mail.send` (after outbound insert), and hotel-sent ingest path.
- Wire `hasReplied` on `mail.get` (= exists outbound) for Outlook-style reply arrow in the list (ever-replied; guest follow-up goes bold again via unread).

## Prevention

- Do not treat “opened” as “handled” for shared hotel mailboxes.
- Any outbound-latest transition (Nava send or hotel-sent ingest) must clear unread for the whole thread if product grey means “ball not with us.”
- Ops backfill: `apps/server-pilot/scripts/backfill-outbound-latest-read.mjs` (dry-run default; `--apply` for explicit ops).

## Related

- Plan: `docs/superpowers/plans/2026-08-04-shared-inbox-replied-auto-read.md`
