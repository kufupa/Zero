---
title: Mail Close Empty Pane Mid-Width and Panel Collapse
date: 2026-08-04
last_updated: 2026-08-05
category: ui-bugs
module: apps/mail mail-shell ResizablePanel list/thread + SidebarToggle
problem_type: ui_bug
component: email_processing
symptoms:
  - "Close/X on mid-width desktop (~768-1023px) left It's empty here empty reading pane instead of inbox list"
  - "Hide inbox collapse via react-resizable-panels appeared to click but did nothing (list could not collapse to 0)"
  - "SidebarToggle icons always looked open; expand control needed to migrate off collapsed list chrome"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
tags:
  - mail-shell
  - close-to-inbox
  - panel-collapse
  - react-resizable-panels
  - mid-width
  - mail-split-v3
  - ec2-pilot
---

# Mail Close Empty Pane Mid-Width and Panel Collapse

## Problem

On mid-width desktop, opening a thread hid the list via CSS while the thread panel stayed mounted. Close cleared `threadId` and showed the empty reading pane ("It's empty here") instead of returning to the inbox list. On wide split, Hide inbox appeared to click but `Panel.collapse()` was a no-op because the thread sibling `maxSize` could not absorb list → 0%. Staff also needed state-true collapse chrome for sidebar and inbox.

## Symptoms

- Mid-width: Close/X clears `threadId` but UI shows "It's empty here" instead of list rows.
- Mid-width: empty thread chrome still occupies the shell after close.
- Wide split: Hide inbox does nothing; Show inbox never appears.
- Expand control trapped inside a zero-width list panel if collapse partially succeeds.
- Sidebar toggle icon always looked open; no `aria-expanded`.
- EC2 read-only Playwright gate failed first on stale `[data-mail-list-queue]`, then on Hide inbox noop until the `maxSize` fix.

## What Didn't Work

1. **Laptop browser without VPN/DNS** — pilot host unreachable; could not prove mid-width Close or Hide inbox locally.
2. **Ad-hoc Playwright smoke from `/tmp`** — `ERR_MODULE_NOT_FOUND` outside the workspace package graph; bad runner placement, not a product bug.
3. **Stale e2e queue selector** — gate looked for `[data-mail-list-queue]`; live list uses date buckets via `data-mail-list-section`. Gate must poll threads/sections, not queue slug attrs.
4. **CSS-only mid-width hide (`hidden lg:block`)** — both panels stayed mounted; Close left empty thread chrome. Mount gating required.
5. **Collapsible list without sibling headroom** — `collapsible` + `collapsedSize={0}` still no-op while thread `maxSize` stayed at complement-of-list-min (72).
6. **Prior plan review** (session history) — eng-review on the same Close/collapse plan already flagged breakpoint matrix and pilot-RDS safety; did not surface the sibling `maxSize` trap until live Hide inbox proof.

## Solution

### 1. Pure visibility helpers (mid-width mount gating)

`apps/mail/lib/mail/mail-panel-visibility.ts`:

- `shouldShowDesktopThreadPanel` — below wide split, thread mounts only when `threadId` is set.
- `shouldShowDesktopListPanel` — below wide split, list mounts when `threadId` is null.
- `shouldShowMailSplitHandle` — wide only; hidden when list collapsed or either panel unmounted.

`mail.tsx` wires these into conditional ResizablePanel mount (`showListPanel` / `showThreadPanel`). Mid-width Close → list-only. Wide always mounts both so collapse/resize work.

Unit coverage: `apps/mail/tests/mail-panel-visibility.test.ts`.

### 2. Drop CSS hide; `autoSaveId` only on wide split

Remove `hidden lg:block` on the list panel. `ResizablePanelGroup` uses `key` per breakpoint band and `autoSaveId={isWideSplit ? 'mail-split-v3' : undefined}` so mid one-panel sizes do not poison wide restores. Locked in `mail-shell-overflow-contract.test.ts`.

### 3. Wide list collapse + Show inbox in thread chrome

List: `collapsible={isWideSplit}`, `collapsedSize={0}`. When collapsed, Show inbox + SidebarToggle live on the thread panel (`data-mail-list-expand`) so controls are not trapped at zero width.

### 4. CRITICAL: thread `maxSize` must be 100 on wide split

`MAIL_THREAD_SPLIT.max` is `100 - MAIL_LIST_SPLIT.min` (= 72) — correct for **expanded** dual-pane drag bounds, wrong as a collapse cap.

```tsx
// before: maxSize={bothDesktopPanels ? MAIL_THREAD_SPLIT.max : 100}
// after:
maxSize={bothDesktopPanels ? (isWideSplit ? 100 : MAIL_THREAD_SPLIT.max) : 100}
```

`collapse()` needs the sibling to absorb list → 0%. Contract test asserts the wide `maxSize` ternary.

### 5. SidebarToggle state-true icons

Open → `PanelLeftClose` + “Hide sidebar”; closed → `PanelLeftOpen` + “Show sidebar”; `aria-expanded={open}`.

### Verification

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run tests/mail-panel-visibility.test.ts tests/mail-shell-overflow-contract.test.ts
# EC2: bash apps/server-pilot/deploy/playwright-real-mail-ui-gate.sh --read-only
# Read-only gate targets two specs (browser-login + launch-readonly);
# launch-readonly asserts mid-width Close + Hide/Show inbox.
```

Preserve `min-w-0` on panels (see [mail-reply-inbox-list-horizontal-shift](./mail-reply-inbox-list-horizontal-shift.md)). Close still awaits compose flush inside `ThreadDisplay.handleClose` before clearing `threadId` (see [compose-close-draft-honesty](../logic-errors/compose-close-draft-honesty.md)).

## Why This Works

Mid-width empty pane was a **lifecycle** bug: unmount thread when `threadId` is null so Close cannot leave empty reading chrome; remount list when selection clears.

Wide Hide inbox was a **resizable-panels constraint** bug: collapse reallocates percent between siblings; thread `maxSize` 72 mathematically forbids list → 0. Wide thread `maxSize` 100 completes collapse; `data-mail-list-expand` keeps a reachable expand affordance at `collapsedSize={0}`.

## Prevention

- Prefer mount gating (pure helpers + conditional JSX) over CSS `hidden lg:*` for mutually exclusive desktop panes; lock with helper unit tests + source contract forbidding `hidden lg:block`.
- When adding `collapsible` / `collapsedSize={0}`, give the sibling `maxSize={100}` (or enough to absorb `100 − collapsedSize`). Complement-of-min max sizes are for expanded drag bounds only.
- Place expand affordances outside the collapsed panel; contract-test order list → thread → `data-mail-list-expand`.
- Bump `autoSaveId` when split semantics change; scope persistence to the dual-pane breakpoint band.
- E2E selectors must match live DOM (`data-mail-list-section`, not stale queue attrs). Mid-width Close must assert no "It's empty here" and visible list threads.
- Never Vitest against pilot RDS. Prove UI on EC2 read-only Playwright when laptop VPN/DNS is unavailable; do not invent `/tmp` smoke runners outside the package graph.
- Keep `min-w-0` on ResizablePanels ([mail-reply-inbox-list-horizontal-shift](./mail-reply-inbox-list-horizontal-shift.md)).

## Related Issues

- [mail-reply-inbox-list-horizontal-shift](./mail-reply-inbox-list-horizontal-shift.md) — shared ResizablePanel / overflow contract; still may cite pre-fix `hidden lg:block` / complement thread `maxSize` samples.
- [compose-close-draft-honesty](../logic-errors/compose-close-draft-honesty.md) — Close path compose flush before clearing selection.
