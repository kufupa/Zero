---
title: Thread Pane Layout Overflow and Radix ScrollArea Viewport Width Inflation
date: 2026-09-07
category: ui-bugs
module: mail thread pane / reading pane UI
problem_type: ui_bug
component: email_processing
symptoms:
  - Reply/Reply All/Forward labels and timestamps clipped off the right edge of the narrow split reading pane
  - Attachment chips clipped with unusable horizontal scroll because flex wrappers lacked min-w-0
  - "Thread Attachments strip appeared between messages instead of at the top of the reading pane"
  - Folder/category pills truncated via hard max-w-[14ch]; sidebar showed dual truncated title plus subtitle
  - Outlook HTML body and banner images ran off mid-word because Radix ScrollArea Viewport table child inflated host width
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags:
  - thread-pane
  - scroll-area
  - radix-viewport
  - min-w-0
  - mail-display
  - attachment-chips
  - shadow-dom
  - layout-overflow
---

# Thread Pane Layout Overflow and Radix ScrollArea Viewport Width Inflation

## Problem

Nava mail’s narrow split reading pane clipped reply actions, attachment chips, and category labels, misplaced the Thread Attachments strip mid-thread, and failed to wrap Outlook HTML body text. The hard failure after surface CSS fixes was width inflation: a Radix ScrollArea Viewport child sized to content (~5kpx) so Shadow wrap rules resolved against the wrong containing block.

## Symptoms

- Reply / Reply All / Forward and timestamps clipped off the right edge of the thread column (worse at ~80% visual scale).
- Many attachment chips clipped with no usable horizontal scroll.
- “Thread Attachments [N]” appeared between newest and oldest messages instead of above the message list.
- Category/folder pills truncated to useless `...` / `Manage Existing...`; sidebar showed two truncated lines.
- Long disclaimer / banner HTML ran off mid-word; widening the pane did not help.
- Live probe (pre-root-fix): Viewport `clientWidth` ≈ 630 (`display: block`) while anonymous Viewport child was `display: table` at ≈ 5038; `mail-content` and MailDisplay ancestors matched ~5038.

## What Didn't Work

- Strengthening only Shadow DOM wrap CSS (`overflow-wrap` / `word-break` / `max-width: 100%`) while host and ancestors still inflated. Percent `max-width` resolved against a content-sized parent, so `hostW` stayed ~5017. (session history: body investigation found wrap CSS present but too weak against nested Outlook tables under `overflow-x-clip`.)
- Measuring body overflow against the inflated host instead of the visible pane — false PASS until probes used pane width.
- Surface-only polish (some `min-w-0`, pill truncate, toolbar label hide) improved chrome but did not stop the Viewport table child from locking the column to content min-width.
- Chip row already intended H-scroll (`flex-nowrap` + track `w-max`), but ancestors with `overflow-x-clip` / missing shrink clipped chips with no usable scroll. (session history)
- Reply toolbar already had wrap in places; labeled actions still refused shrink (`whitespace-nowrap` / `shrink-0`) inside X-clipping parents. (session history)
- Leaving Radix Viewport’s injected `display: table; min-width: 100%` child untreated — that was the width ratchet for wide banners.
- Stamping `.env.remote-common` with unquoted `NAVA_BUILD_COMMIT=` via `sed` broke `write-ec2-remote-env --validate` (expects `KEY='value'`).

## Solution

Two-commit fix on `fix/thread-pane-layout-overflow`.

### Surface layout (`3dc66dc8`)

- Render `ThreadAttachments` once **before** `displayMessages.map`, not on the chronologically oldest `MailDisplay` (newest-on-top made “oldest” paint mid-list).
- `min-w-0` on MessageList wrappers / ScrollArea so attachment scrollports can shrink; track stays `w-max` inside `overflow-x-auto`.
- Reply `ActionButton`: `aria-label`, labels `hidden md:inline`, drop outer `shrink-0` that fought the toolbar.
- `CenturionCategoryPill`: drop `max-w-[14ch]`; `max-w-full truncate` + `title=`.
- `nav-main`: title-only row; subtitle only in tooltip.
- Mail-content host: `min-w-0 max-w-full`.
- Shadow CSS twins (`resolve-mail-html.ts` + `mail-body-typography.ts`): wrap/break on cells (necessary, not sufficient alone).

### Root fix — Viewport inflate (`a45feb05`)

```ts
// apps/mail/lib/attachment-chip-scroll.ts
export const SCROLL_AREA_VIEWPORT_CONTENT_CLASS =
  '[&>div]:!block [&>div]:min-w-0 [&>div]:max-w-full [&>div]:w-full';
```

Apply on every mail `ScrollArea` Viewport (`scroll-area.tsx`) alongside `SCROLL_AREA_FLEX_MIN_W_CLASS`.

Shadow defense (twins kept in sync):

- `:host { contain: inline-size; width/max-width: 100%; min-width: 0; }`
- `table { table-layout: fixed; width: 100%; }`
- `img { max-width: 100%; height: auto; }`

### Tests / live proof

- Contract: `attachment-chip-scroll.test.ts` locks `SCROLL_AREA_VIEWPORT_CONTENT_CLASS`.
- `resolve-mail-html.test.ts` asserts `contain: inline-size` and `table-layout: fixed`.
- Live after deploy: `hostW` = paneW ≈ 630; banner widest ≈ 605; chip track still ~5k **inside** scrollport (correct chip H-scroll).

## Why This Works

Radix Viewport injects an anonymous child with `display: table; min-width: 100%`. Tables size to content; a wide Outlook banner pushed that child to ~5038px and the whole MailDisplay chain followed. Nested `max-width: 100%` then resolved against the inflated parent — wrap looked broken. `overflow-x-clip` hid paint overflow while `clientWidth` stayed huge.

Forcing the Viewport child to `block` + `min-w-0` / `max-w-full` / `w-full` lets the flex column define width. The mail host matches the pane, so Shadow wrap and fixed tables finally apply. Surface changes stop chrome and misplaced Thread Attachments from adding their own min-content pressure.

## Prevention

- Keep `SCROLL_AREA_VIEWPORT_CONTENT_CLASS` on mail ScrollArea Viewports; lock with the unit contract test.
- Keep `min-w-0` / `max-w-full` on flex column hosts (`mail-content`, MessageList, MailDisplay shells).
- Layout probes: compare body/banner/`hostW` to **pane** width, never host-vs-inflated-descendant alone.
- Keep Shadow CSS twins in sync and covered by `resolve-mail-html` tests.
- Attachment chips: outer scrollport + inner `w-max` track — never `flex-nowrap` + `overflow-x-auto` on the same node.
- Remote env stamps: always `KEY='value'` for `.env.remote-common`; bare `KEY=` fails `--validate`.

## Related Issues

- [Mail Reply Inbox List Horizontal Shift](./mail-reply-inbox-list-horizontal-shift.md) — same MessageList ScrollArea / `min-w-0` shell; RC is flex `min-width: auto` + sideways `scrollIntoView`, not Viewport `display: table`.
- [Mail Reply Composer Footer and Recipient Containment](./mail-reply-composer-footer-recipient-containment.md) — inner reading-pane children need their own shrink rules beyond outer shell `min-w-0`.
- [Mail Reply Actions in Message and Thread Toolbar](./mail-reply-actions-in-message-and-thread-toolbar.md) — toolbar placement / responsive labels; defers narrow-pane containment to horizontal-shift.
- [Outlook Newest-on-Top Thread](./outlook-newest-on-top-thread-reply-above.md) — newest-first list boundary; Thread Attachments must not hang on chronologically oldest `MailDisplay`.
