---
title: Mail Close Empty Pane Mid-Width and Panel Collapse
date: 2026-08-04
category: ui-bugs
module: apps/mail mail-shell ResizablePanel list/thread + SidebarToggle
problem_type: ui_bug
component: email_processing
symptoms:
  - "Close/X on narrow desktop (~768-1023px) left It's empty here reading pane instead of inbox list"
  - "No clear inbox list collapse control; sidebar toggle icon always looked open"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
tags:
  - mail-shell
  - close-to-inbox
  - panel-collapse
  - react-resizable-panels
  - mid-width
  - ec2-pilot
---

# Mail Close Empty Pane Mid-Width and Panel Collapse

## Problem

On mid-width desktop, opening a thread hid the list via `hidden lg:block` while the thread panel stayed mounted. Close cleared `threadId` and showed the empty reading pane ("It's empty here") instead of returning to the inbox list. Staff also needed on-theme collapse controls for nav + inbox.

## Solution

1. Pure helpers in `apps/mail/lib/mail/mail-panel-visibility.ts` gate desktop list/thread mount: below `lg`, thread mounts only when `threadId` is set; Close → list-only.
2. Drop CSS `hidden lg:block`; bump `autoSaveId` to `mail-split-v3` (wide split only).
3. `lg+` list panel `collapsible` via existing `react-resizable-panels@2.1.7`; expand control migrates into thread chrome (`data-mail-list-expand`) so it is never trapped at `collapsedSize={0}`.
4. Thread panel `maxSize` must be `100` on wide split — complement `max` (`100 - list.min` = 72) blocks `collapse()` because the sibling cannot absorb the freed percent.
4. `SidebarToggle` state-true icons (`PanelLeftClose` / `PanelLeftOpen` in custom `icons.tsx`), tooltip, `aria-expanded`.

## Verification

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run tests/mail-panel-visibility.test.ts tests/mail-shell-overflow-contract.test.ts
```

Preserve `min-w-0` on panels (see mail-reply-inbox-list-horizontal-shift). Close still awaits compose flush inside `ThreadDisplay.handleClose` before clearing `threadId`.
