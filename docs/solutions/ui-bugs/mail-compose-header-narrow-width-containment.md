---
title: Mail compose To-row header containment at narrow widths
date: 2026-08-20
category: ui-bugs
module: apps/mail email-composer To-row header
problem_type: ui_bug
component: email_processing
symptoms:
  - "At narrow widths, reply/compose To recipient row refused to shrink inside flex justify-between header"
  - "Sibling Cc / Bcc / close controls got squeezed or overflowed the header"
  - "To row wrapper used flex w-full (min-width auto / flex item greed) instead of shrinkable containment"
root_cause: scope_issue
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags:
  - compose
  - header
  - min-w-0
  - narrow-viewport
  - flex-containment
  - email-composer
  - source-contract
---

# Mail compose To-row header containment at narrow widths

## Problem

In the hotel mail reply composer, the recipient header is a horizontal flex row: the To field on the left and reply chrome actions (Cc, Bcc, and optional close) on the right. The To-side wrapper used Tailwind `w-full`, which forces the recipient column to claim the full width of the flex header. At narrow thread or zoomed desktop widths, that left column would not surrender horizontal space to its siblings, so the action cluster was squeezed, clipped, or pushed out of the usable header instead of sharing the row.

## Symptoms

- With To wrapper on `w-full`, expected flex behavior at constrained widths: recipient column claims the header line and leaves little room for Cc / Bcc / close beside it.
- Recipient autosuggest and action buttons competed for the same header width instead of trading space; the To side behaved like a full-width block inside a `justify-between` flex parent.
- Geometry / containment issue only: compose, draft ownership, and send paths were unaffected by the class-token fix.
- Most relevant when the thread panel is already width-constrained (split desktop or zoom).

## What Didn't Work

- Treating the symptom as a reply-only layout fork. The broken class lived on the shared `EmailComposer` To row, so reply-composer wrappers alone could not fix sibling flex sharing.
- Relying on the parent `flex justify-between` header alone. Sibling distribution still fails when one child asserts `w-full` and keeps a non-zero flex min-width from content.
- Assuming shell-level `min-w-0` on mail list/thread panels (see [Mail Reply Inbox List Horizontal Shift on Narrow Viewport](./mail-reply-inbox-list-horizontal-shift.md)) would automatically fix every nested composer header. Outer shell shrinkability does not replace a correct flex child on the To row itself.
- Leaving the class tokens unlocked. Without a source contract, a later styling pass could restore `w-full` and reintroduce the squeeze at narrow widths.

## Solution

Replace the To-row width claim with shrinkable flex growth so the recipient column takes remaining space but can go below its intrinsic min-content when the action cluster needs room.

**Before:** To-side wrapper used `w-full` inside the header flex.

**After (on main):** To-side wrapper uses `min-w-0 flex-1` and must not use `w-full`.

```983:993:apps/mail/components/create/email-composer.tsx
          <div className="flex justify-between px-3 pt-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <p className="text-sm font-medium text-[#8C8C8C]">To:</p>
              <RecipientAutosuggest
                control={form.control}
                name="to"
                placeholder="Enter email address"
                disabled={isLoading}
                onValueChange={markUnsavedChanges}
              />
            </div>
```

Sibling actions remain in a separate non-`w-full` cluster (`Cc` / `Bcc` / optional close) beside that row in the same `justify-between` parent.

The fix is on `main` (merge message: `fix(mail): contain reply header at narrow widths`).

## Why This Works

Flex items default to `min-width: auto`, so a wide recipient control can refuse to shrink below its content size. `w-full` compounds that by telling the To column to occupy 100% of the header, which fights `justify-between` sibling sharing.

`flex-1` lets the To column grow into leftover space. `min-w-0` overrides the auto minimum so the column may shrink when Cc / Bcc / close need room. Together they keep the recipient field as the flexible primary column without locking the full header width.

Same containment idea as mail-shell shrinkable flex children: nested chrome stays inside the panel instead of overflowing siblings — applied here at the composer header row, not the resizable list/thread shell.

## Prevention

- Prefer `min-w-0 flex-1` (or equivalent shrinkable flex growth) for primary fields that share a row with fixed action chrome; avoid `w-full` on that flex child.
- Keep the Vitest source contract that forbids `w-full` on the To row and requires `min-w-0` + `flex-1`: `apps/mail/tests/compose-header-containment-contract.test.ts`.
- When changing reply open behavior or composer chrome, re-check narrow / zoomed thread widths: containment first, then visual polish.
- Before Vitest, unset `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS`; this contract is database-independent.

## Related Issues

- [Mail Reply Inbox List Horizontal Shift on Narrow Viewport](./mail-reply-inbox-list-horizontal-shift.md) — same `min-w-0` pattern + source-contract practice; shell ResizablePanel surface, not composer To-row.
- [Mail Close Empty Pane Mid-Width and Panel Collapse](./mail-close-empty-pane-mid-width.md) — preserves shell `min-w-0`; mid-width mount/collapse.
- [Mail Sidebar Toggle Placement](./mail-sidebar-toggle-placement.md) — adjacent responsive mail chrome.
- [Sender click copies email](./sender-click-copies-email.md) — incidental `min-w-0` on sender row; different bug class.
