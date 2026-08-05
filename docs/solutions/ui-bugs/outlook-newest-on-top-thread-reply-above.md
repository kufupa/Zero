---
title: Outlook Newest-on-Top Thread with Reply Composer Above Target
date: 2026-08-03
category: ui-bugs
module: apps/mail thread display / reply compose
problem_type: ui_bug
component: email_processing
severity: medium
symptoms:
  - "Reading pane rendered thread oldest-first, unlike Outlook newest-on-top expectation"
  - "Reply box under target was tiny (EmailComposer min-h ~50px override)"
  - "Sticky-bottom latest composer fought reading-pane scroll"
  - "ThreadAttachments gated on index===0 after newest-first reorder never painted on multi-msg threads"
  - "Open-scroll shared activeReplyId deps and yanked viewport on mid-thread reply"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - testing_framework
tags:
  - mail-thread
  - reply-composer
  - newest-on-top
  - outlook
  - thread-attachments
  - reading-pane
---

# Outlook Newest-on-Top Thread with Reply Composer Above Target

## Problem

Hotel mail reading pane followed API chronological order (oldest → newest). Reply sat under the target message; latest reply used a sticky bottom bar; reply editor forced `min-h-[50px]`. Staff expected Outlook-style newest-on-top, a usable reply box, and the composer above the message they clicked.

Mail thread UX is FE display only: `mail.get` stays ascending by `receivedAt`; `latest` remains chronological last. Committed on branch `EC2-pilot` as of 2026-08-03 (no PR number; local-only — SHA may rewrite on rebase/squash). That same commit also hitchhiked an unrelated HMS allowlist rename (`guestNumber` → `guestnumber`); ignore for this learning.

## Symptoms

- Multi-message threads opened with oldest at top; newest buried at bottom.
- Click Reply: composer appeared under the target (or sticky-bottom for latest only), not above it.
- Reply editor felt like a thin strip — `ReplyCompose` overrode shared `EmailComposer` height with `editorClassName="min-h-[50px]"`.
- Sticky-bottom latest composer competed with reading-pane scroll.
- After newest-first reverse, `ThreadAttachments` nested under `index === 0` subject chrome while prop still passed only to chronological oldest → strip never painted on multi-message threads.
- Open-thread scroll shared deps with `activeReplyId`; starting a mid-thread reply could yank viewport toward newest.

## What Didn't Work

- **`buildThreadMessageSlots` (or similar).** Eng review wanted a slots API for placement tests. Ponytail cut it: one `orderMessagesNewestFirst` helper + JSX reply-before-`MailDisplay`.
- **Sort-by-`receivedOn` / oldest-id helpers.** Cut as YAGNI; API-asc input is already guaranteed.
- **First post-impl review REJECT.** Newest-first alone left attachments unpainted and mid-reply scroll racing latest open-scroll.
- **Laptop live browser against pilot hostname.** `nava.legacyhotels.co.za` does not resolve without VPN from the laptop. Verified via SSM instead (HEAD + built SPA markers). (session history: prior thread/reply sessions mostly covered stale poll, draft honesty, list IA — not newest-on-top.)

## Solution

### 1. Newest-first helper

```1:4:apps/mail/lib/mail/thread-display-order.ts
/** Assumes messages are API-asc (oldest → newest). Returns newest-first for the reading pane. */
export function orderMessagesNewestFirst<T>(messages: readonly T[]): T[] {
  return [...messages].reverse();
}
```

Tests: `apps/mail/tests/thread-display-order.test.ts`.

### 2. MessageList: reverse, reply above, no sticky bottom

```1193:1224:apps/mail/components/mail/thread-display.tsx
  const displayMessages = orderMessagesNewestFirst(messages || []);
  // ...
          const isChronologicallyOldest = index === displayMessages.length - 1;
          // ReplyCompose ABOVE MailDisplay when activeReplyId matches
          // threadAttachments on chronologically oldest (last visual index)
```

Sticky-bottom latest-only mount deleted. Open-reply scroll uses `block: 'nearest'`.

### 3. Drop reply `min-h-[50px]`

`apps/mail/components/mail/reply-composer.tsx` no longer passes `editorClassName`; shared composer default `min-h-[200px]` applies.

### 4. Semantic latest scroll; split from reply deps

```531:549:apps/mail/components/mail/mail-display.tsx
  // collapse effect: depends on activeReplyId
  // separate open-scroll effect: isLastEmail + totalEmails only (no activeReplyId)
```

### 5. ThreadAttachments outside `index === 0`

```1128:1130:apps/mail/components/mail/mail-display.tsx
            {threadAttachments && threadAttachments.length > 0 && (
              <ThreadAttachments attachments={threadAttachments} />
            )}
```

## Why This Works

- Single reverse at list boundary keeps API/`latest`/hotkeys stable while pane matches Outlook.
- Reply-before-`MailDisplay` for any target removes sticky-bottom fork that assumed newest-at-bottom.
- Semantic `latest.id` survives display reorder; raw display index does not.
- Attachments prop on chronological oldest + render outside subject-chrome gate restores the strip.
- Split effects stop reply open from re-triggering long-thread scroll-to-newest.

## Prevention

- After any display reorder, audit every `index === 0` / last-index gate (subject vs thread-level chrome).
- Keep long-thread open-scroll out of `activeReplyId` collapse effects.
- Prefer one order helper + JSX over speculative slots APIs.
- Do not thin `EmailComposer` default height for reply unless product asks for compact mode.
- Pilot UI: VPN/DNS required from laptop; use SSM SPA markers when hostname will not resolve. Never Vitest against pilot RDS.

## Related Issues

- Plan: `docs/plans/2026-08-03-001-feat-outlook-thread-order-reply-size-plan.md`
- Executable plan: `docs/superpowers/plans/2026-08-03-outlook-thread-order-reply-size.md`
- Adjacent: `docs/solutions/ui-bugs/mail-reply-inbox-list-horizontal-shift.md` (same MessageList / `#reply-composer` / `scrollIntoView` surface — re-check narrow viewport after placement change)
