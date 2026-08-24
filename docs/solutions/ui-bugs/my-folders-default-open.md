---
title: My folders defaults open while retaining manual collapse
date: 2026-08-22
category: ui-bugs
module: apps/mail sidebar navigation
problem_type: ui_bug
component: email_processing
severity: low
symptoms:
  - Before the fix, My folders started collapsed, hiding user filing labels.
root_cause: logic_error
resolution_type: code_fix
tags:
  - my-folders
  - user-filing
  - sidebar
  - collapsible
  - default-open
---

# My folders defaults open while retaining manual collapse

## Problem

Before the fix, the My folders sidebar block was configured closed on first render. When its existing render gate allows it, My folders must initially reveal its labels while retaining the existing manual-collapse affordance.

## Symptoms

- Before the fix, source configured the My folders `Collapsible` with `defaultOpen={false}`.
- Removing the existing chevron control would have broken the manual-collapse affordance.

## What Didn't Work

- Reusing historical Labels guidance that used `defaultOpen={false}` would reintroduce the closed initial state. That guidance describes the former Labels chrome, not the current My folders user-filing surface ([Hotel Folder UI Parity](hotel-folder-ui-parity.md)).
- Replacing the existing collapsible or deleting its trigger was unnecessary: the required control already existed.

## Solution

Set the My folders `Collapsible` default prop open and leave its trigger and content intact:

```tsx
<Collapsible defaultOpen={true} className="group/collapsible flex-col">
  <CollapsibleTrigger asChild>{/* My folders button */}</CollapsibleTrigger>
  <CollapsibleContent>{/* SidebarLabels */}</CollapsibleContent>
</Collapsible>
```

The current implementation passes `defaultOpen={true}` at `apps/mail/components/ui/nav-main.tsx:290`, retains `CollapsibleTrigger` around the My folders button at `apps/mail/components/ui/nav-main.tsx:293-301`, and keeps `SidebarLabels` in `CollapsibleContent` at `apps/mail/components/ui/nav-main.tsx:318-320`.

## Why This Works

The implementation changes only the collapsible default prop. The current source still contains the existing trigger and content in the same My folders block, so the manual-collapse affordance remains present; the implemented fix added no state, effect, API, or data-model change.

## Prevention

- Treat initial visibility and manual collapsibility as separate requirements: update the default prop without removing the trigger or content.
- Keep `apps/mail/tests/my-folders-default-open.test.ts:9-14`. Its source contract requires ordered `defaultOpen={true}`, `CollapsibleTrigger asChild`, and `MY_FOLDERS_SIDEBAR_TITLE` tokens; current source places them in one My folders `Collapsible`.
- Before focused Vitest verification, unset `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS`; live-pilot database tests are prohibited.

## Related Issues

- [My folders filing via mailLabel plus archive](../architecture-patterns/my-folders-label-archive-filing.md) defines My folders as user filing, distinct from AI-managed hotel Folders.
- [Hotel Folder UI Parity](hotel-folder-ui-parity.md) has a stale Labels/default-open reference and needs a narrow refresh.
