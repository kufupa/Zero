---
title: Mail Reply Composer Footer and Recipient Containment
date: 2026-08-22
category: ui-bugs
module: "apps/mail reply composer / shared email composer recipient header"
problem_type: ui_bug
component: email_processing
severity: medium
symptoms:
  - "Reply or Reply All could leave composer controls below the visible reading-pane viewport."
  - "A long To, Cc, or Bcc recipient could force horizontal overflow and hide header controls."
  - "Control visibility depended on an arbitrary parent scroll delay rather than the mounted composer."
root_cause: logic_error
resolution_type: code_fix
related_components:
  - testing_framework
tags:
  - mail-thread
  - reply-composer
  - reply-all
  - recipient-autosuggest
  - footer-alignment
  - horizontal-overflow
  - narrow-viewport
  - real-mail
---

# Mail Reply Composer Footer and Recipient Containment

## Problem

Inline Reply and Reply All compose must keep Send, Cc, Bcc, and Close reachable
inside a constrained mail reading pane. The composer mounts immediately before
its target message, so footer visibility and recipient width containment belong
to the inline composer rather than pop-out compose or the outer mail shell.

## Symptoms

- Reply or Reply All could leave the composer footer outside the visible thread
  viewport.
- A very long recipient could expand the To/Cc/Bcc header horizontally, making
  controls unreachable.
- The defect was more visible in a short or narrow desktop viewport.

## What Didn't Work

- **Relying only on outer-shell containment.** The existing mail-shell
  `min-w-0` and `ResizablePanel` rules prevent the inbox/list split from
  widening, but cannot make a recipient chip shrink within the composer header.
- **Parent-owned delayed scrolling.** The former `ThreadDisplay` lookup used a
  timeout and `block: 'nearest'`; it was not coupled to the actual mounted
  composer or its footer geometry.
- **Clipping overflow as a footer strategy.** The composer root is bounded, but
  clipping cannot make a hidden footer reachable. The middle content must be
  the shrinkable scroll region instead.
- **Unscoped real-mail UI mutation.** A live geometry test must not use an
  arbitrary pilot thread or draft.

## Solution

### 1. Align the mounted composer footer

`ReplyCompose` owns one element ref and schedules alignment only after that
element mounts:

```tsx
const [replyComposeViewportElement, setReplyComposeViewportElement] =
  useState<HTMLDivElement | null>(null);

replyComposeViewportElement.scrollIntoView({
  behavior,
  block: 'end',
  inline: 'nearest',
});
```

The effect waits for `mode`, `messageId`, and the mounted element, runs in
`requestAnimationFrame`, honors reduced motion, checks that the element is
still connected, and cancels pending work on cleanup
(`apps/mail/components/mail/reply-composer.tsx:59-92`). The wrapper uses
`ref={setReplyComposeViewportElement}`
(`apps/mail/components/mail/reply-composer.tsx:392-397`).

The old `ThreadDisplay` timeout/ID-query scroll path was removed. The composer
remains inline before `MailDisplay`, inside the reading-pane `ScrollArea`
(`apps/mail/components/mail/thread-display.tsx:1221-1244`).

### 2. Preserve vertical footer space

`EmailComposer` is a bounded column: its middle region is
`min-h-0 flex-1 overflow-y-auto`, while the footer is `shrink-0`
(`apps/mail/components/create/email-composer.tsx:842-844`,
`apps/mail/components/create/email-composer.tsx:946-983`). Content can scroll
instead of pushing the footer out of the composer.

### 3. Complete the recipient shrink chain

The To/Cc/Bcc rows use `min-w-0`; labels and the Cc/Bcc/Close control cluster
are `shrink-0`; the recipient region flexes. `RecipientAutosuggest` continues
that boundary through its root, inner row, chips, text, remove control, and
raw input:

```tsx
<div className={cn('relative min-w-0 flex-1', className)}>
  <div className="flex min-w-0 flex-wrap items-center gap-2 min-h-[32px]">
    <div className="flex min-w-0 max-w-full items-center gap-1 ...">
      <span className="min-w-0 flex-1 truncate" title={email}>{email}</span>
    </div>
  </div>
</div>
```

The full recipient remains available through `title`, and the remove control
has an address-specific accessible name
(`apps/mail/components/ui/recipient-autosuggest.tsx:264-307`). Cc, Bcc, and
Close are real `type="button"` controls; Close has `aria-label="Close composer"`
(`apps/mail/components/create/email-composer.tsx:844-912`).

### 4. Lock the behavior with focused contracts

- `apps/mail/tests/reply-composer-viewport-contract.test.ts` requires one
  mounted-element animation-frame effect, end alignment, reduced-motion
  handling, cleanup, inline placement, and absence of the old parent
  workaround.
- `apps/mail/tests/compose-header-containment-contract.test.ts` requires the
  full shrink/truncation chain and reachable header controls.
- `apps/mail/tests/real-mail-reply-viewport-safety-contract.test.ts` guards
  safe live-test ownership and cleanup.

The opt-in Playwright scenario uses a 1050×640 desktop viewport. It requires
all explicit mutation gates, a dedicated thread, a configured disposable draft
ID, and a draft marker before it opens Reply and Reply All. It verifies both
vertical control geometry and long-recipient horizontal containment, then only
accepts a successful exact-ID `/drafts.delete` cleanup
(`apps/mail/tests/e2e/real-mail-compose-close-honesty.spec.ts:22-28,
184-338, 461-539`).

## Why This Works

Flex items retain content-derived minimum sizes unless each relevant boundary
permits shrinking. `min-w-0` from the reading pane through recipient text turns
a long address into truncated content instead of document geometry.

Vertically, `min-h-0` permits the middle flex region to scroll while the footer
retains its height. Mount-local end alignment then prioritizes that bounded
footer edge without an arbitrary parent delay or a horizontal-scroll preference.

## Prevention

- Treat the `min-w-0` recipient chain and `shrink-0` footer as load-bearing
  layout behavior.
- Keep reply alignment with the mounted composer; do not reintroduce a parent
  timeout, DOM ID query, or `ResizeObserver` workaround.
- Retain recipient `title` and remove-button `aria-label` when truncating
  tokens.
- Re-run the static contracts whenever reply placement, header synchronization,
  or composer sizing changes.
- Run the real-mail scenario only with its explicit gate and dedicated,
  disposable resources; it must verify exact draft ownership before cleanup.

## Related Issues

- [Mail Reply Inbox List Horizontal Shift](mail-reply-inbox-list-horizontal-shift.md)
  — outer mail-shell containment; distinct from local composer containment.
- [Outlook Newest-on-Top Thread with Reply Composer Above Target](outlook-newest-on-top-thread-reply-above.md)
  — inline placement and thread order; distinct from footer prioritization.
- [Mail Reply Actions in Recipient Headers and Thread Toolbar](mail-reply-actions-in-message-and-thread-toolbar.md)
  — visible response action placement and responsive chrome.
- [Compose close draft honesty](../logic-errors/compose-close-draft-honesty.md)
  — draft persistence and close semantics, not viewport geometry.
