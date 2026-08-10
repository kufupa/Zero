---
title: Mail Reply Actions in Recipient Headers and Thread Toolbar
date: 2026-08-10
category: ui-bugs
module: apps/mail reading view
problem_type: ui_bug
component: frontend_stimulus
severity: medium
symptoms:
  - "Reply, Reply All, and Forward were not consistently visible at each message recipient header or together in the thread toolbar."
root_cause: missing_workflow_step
resolution_type: code_fix
related_components:
  - testing_framework
tags:
  - mail
  - reply-actions
  - message-header
  - thread-toolbar
  - ec2-pilot
---

# Mail Reply Actions in Recipient Headers and Thread Toolbar

## Problem

The reading view did not expose Reply, Reply All, and Forward in the two
staff-facing locations where their scope is clearest: beside an individual
message's recipients and together in the thread toolbar. Existing context-menu
and keyboard entry points needed to remain available.

## Symptoms

- The former per-message action row was below the mail body rather than beside
  the message's recipient context.
- The thread toolbar had a standalone Reply All control instead of all three
  response modes together.
- A reader could not rely on one visible action group for a selected message
  and another for the latest message in the thread.

## What Didn't Work

- Keeping the body-bottom row did not provide stable recipient context. The
  source contract now requires exactly one named message-action group before
  the mail body and rejects the former wrapper
  (`apps/mail/tests/mail-reply-actions-contract.test.ts:141-164`).
- A standalone toolbar Reply All control did not make every response mode
  discoverable. The toolbar contract requires one named group before
  `NotesPanel`, three visible native buttons, and no former standalone wrapper
  (`apps/mail/tests/mail-reply-actions-contract.test.ts:186-229`).
- Local browser proof was unavailable during this session. The session record
  says EC2 read-only browser proof replaced it after a canonical deploy stopped
  on unrelated server-pilot TypeScript errors; a frontend-only mail asset
  refresh avoided changing the backend runtime. This is historical
  release-session evidence, not a general deployment rule
  (`.superpowers/sdd/mail-reply-actions-progress.md:15-17`).

## Solution

`MailDisplay` renders a named `Message reply actions` group as a sibling of
the To/Cc/Bcc summary. The recipient summary stays shrinkable while the action
group wraps when constrained; it contains Reply, Reply All, and Forward
(`apps/mail/components/mail/mail-display.tsx:1381-1442`).

Each message action calls `openComposeForMessage` with the selected mode. That
helper passes the rendered message's `emailData.id` into
`openReplyComposeContext`, so message-level actions preserve the selected
message as their compose target
(`apps/mail/components/mail/mail-display.tsx:516-529`).

`ThreadDisplay` renders a separate `Thread reply actions` group before
`NotesPanel`, again with Reply, Reply All, and Forward. Its
`openComposeForLatestMessage` helper passes `emailData?.latest?.id`, keeping
thread-toolbar actions scoped to the thread's latest message
(`apps/mail/components/mail/thread-display.tsx:260-272`;
`apps/mail/components/mail/thread-display.tsx:979-1025`).

The other intended entry points remain:

- Thread context-menu handlers use the latest message for Reply, Reply All, and
  Forward (`apps/mail/components/context/thread-context.tsx:343-414`).
- Thread hotkeys use the same latest-message target for reply, reply-all, and
  forward (`apps/mail/lib/hotkeys/thread-display-hotkeys.tsx:35-66`).
- The source contract asserts both visible groups, all three modes, placement,
  propagation protection, responsive containment, alternate entry points, and
  compose-free ellipsis menus
  (`apps/mail/tests/mail-reply-actions-contract.test.ts:141-299`).
- Pilot context-menu coverage asserts visible Reply, Reply all, and Forward
  items (`packages/testing/e2e/mail-actions.spec.ts:4-20`).

The session record reports EC2 SSM browser proof for one visible message action
group and one visible toolbar group, both containing all three response modes,
without a guarded mail mutation. That is verification-session evidence rather
than behavior inferred from the current tree
(`.superpowers/sdd/mail-reply-actions-progress.md:17`).

## Why This Works

The two placements have intentionally different scopes without duplicating
compose-state logic:

- A message-header action sends its message ID to the shared compose-context
  helper.
- The toolbar, context menu, and hotkeys consistently send the latest message
  ID.

Named groups make placement testable. The responsive `min-w-0` and wrapping
classes provide containment on narrower screens; verify visual usability
separately. Visible controls avoid hiding core response modes behind overflow
menus.

## Prevention

- Keep `apps/mail/tests/mail-reply-actions-contract.test.ts` focused on action
  placement, modes, target semantics, and responsive containment.
- When changing recipient-header or toolbar chrome, preserve all three visible
  response modes and verify message-level versus latest-message targets.
- Keep context-menu and `r` / `a` / `f` keyboard paths covered as alternate
  entry points; they should not drift from toolbar latest-message semantics.
- Treat EC2 browser proof as the appropriate visual fallback when a
  VPN-dependent pilot UI cannot be validated from the local browser. Do not
  run Vitest against pilot RDS.

## Related Issues

- [Outlook newest-on-top thread reply placement](outlook-newest-on-top-thread-reply-above.md)
  — adjacent thread ordering and composer-above-target behavior.
- [Mail reply inbox list horizontal shift](mail-reply-inbox-list-horizontal-shift.md)
  — preserve narrow-viewport containment when changing reply chrome.
- [Mail open-thread stale data and recipient You label](../logic-errors/mail-open-thread-stale-and-recipient-you-label.md)
  — related recipient rendering, distinct from action placement.
- [Playwright E2E EC2 pilot UI gate](../test-failures/playwright-e2e-ec2-pilot-ui-gate.md)
  — EC2 browser-proof setup, distinct from reading-view action placement.
