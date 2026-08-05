---
title: Mail open-thread stale after ingest and outbound To You mislabel
date: 2026-07-23
category: logic-errors
module: apps/mail thread detail refresh and recipient label
problem_type: logic_error
component: email_processing
severity: medium
symptoms:
  - "Opened thread detail does not show new POP3 replies until browser hard refresh"
  - "Inbox list bumps threads to top on poll while open thread pane stays on cached messages"
  - "Outbound messages viewed from inbox show To: You for any single recipient"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - email_processing
tags:
  - mail-thread
  - react-query
  - refetch-interval
  - recipient-label
  - ec2-pilot
  - pop3-sync
  - open-thread-poll
---

# Mail open-thread stale after ingest and outbound To You mislabel

## Problem

On the live Nava mail pilot, a Gmail reply could be ingested and present in Postgres while the open thread pane still showed only the outbound message. Separately, outbound mail opened under inbox displayed **To: You** instead of the external recipient, which looked like reversed headers. Both failures were frontend logic; server ingest and `mail.get` were already correct.

## Symptoms

- Thread list could bump after a reply while the open conversation stayed on one message until hard refresh.
- Worker logs showed `listed=1 processed=1`; thread `de81801e` held outbound + inbound `Re: test`.
- Authenticated `mail.get` returned both messages; hard refresh painted them immediately.
- Outbound row under inbox showed **To: You** though `to` was `aroransh17@gmail.com`.
- Inbound reply From/To were correct — not a MIME header reversal.

## What Didn't Work

- Assuming POP3 ingest failed because the reply was invisible in the open pane. DB and worker already had the message.
- Treating **To: You** as proof of reversed From/To headers. Wire data was correct; only the display rule was wrong.
- Treating list poll (~15s) alone as near-realtime parity. (session history) Live-pilot parity work wired `useThreads` / `VITE_MAIL_POLL_MS` and `forceSync`, but left `useThread` on a one-hour `staleTime` with no `refetchInterval`, so list and detail diverged.
- Waiting for window-focus refetch on the detail query while keeping an hour-long stale window — an open pane would not pick up replies without navigation or hard refresh.

## Solution

Shipped in commit `59ab6e3b` with TDD on the two pure helpers.

### Open-thread poll

List already used `resolveThreadPollingMs`. Open detail now shares `openThreadQueryPollingOptions` from `apps/mail/lib/mail/thread-polling-policy.ts`, wired into `useThread` in `apps/mail/hooks/use-threads.ts`:

```typescript
refetchInterval: openThreadPolling.refetchInterval,
refetchIntervalInBackground: openThreadPolling.refetchIntervalInBackground,
refetchOnWindowFocus: openThreadPolling.refetchOnWindowFocus,
```

Default interval is 15s (same floor as the list). Invalid env disables polling.

### Recipient You label

`apps/mail/lib/mail/recipient-you-label.ts` exposes `shouldCollapseRecipientToYou`. Collapse only when folder is not `sent`, there is a single To, no Cc, and the recipient equals the active mailbox email (case-insensitive). `mail-display.tsx` calls that helper with `activeConnection?.email` instead of `folder !== 'sent' && to.length === 1`.

## Why This Works

List and detail were separate React Query surfaces. List polling could refresh `latestMessageAt` and reorder threads while the open `mail.get` cache stayed warm for an hour. Matching foreground poll (+ focus refetch) on `useThread` makes new inbound rows appear without leaving the thread.

**To: You** is only correct for mail addressed to the signed-in mailbox. Outbound messages viewed from inbox still have `folder === 'inbox'`, so a folder-only heuristic mislabeled them. Comparing normalized addresses keeps friendly **You** for true inbound singles and shows real addresses for outbound/external recipients.

## Prevention

- Keep list and open-thread query options on the shared policy helper in `thread-polling-policy.ts` — do not duplicate intervals in hooks.
- Keep recipient display rules in pure functions with unit tests; avoid folder-only shortcuts in JSX.
- When users report “missing reply,” check worker + `mail.get` before changing POP3. If server has the message, inspect open-thread `refetchInterval` / `staleTime` first.
- Tests: `apps/mail/tests/thread-polling-policy.test.ts` (open thread polls at list default; invalid env disables) and `apps/mail/tests/recipient-you-label.test.ts` (external To in inbox does not collapse to You; mailbox match does).

## Related Issues

- [live-pilot-production-parity-real-mail.md](../architecture-patterns/live-pilot-production-parity-real-mail.md) — list poll / forceSync parity; open-thread poll closes the remaining gap
- [mail-draft-refresh-data-loss-and-lifecycle.md](mail-draft-refresh-data-loss-and-lifecycle.md) — inverse React Query failure (over-refetch clobbering drafts)
- [playwright-e2e-ec2-pilot-ui-gate.md](../test-failures/playwright-e2e-ec2-pilot-ui-gate.md) — AE8 reply visibility assumes SPA refresh path includes open pane
- [mail-transport-mode-fixture-vs-real.md](../architecture-patterns/mail-transport-mode-fixture-vs-real.md) — ingest path when symptoms look like “mail never arrived”
