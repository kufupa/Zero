---
title: "Mail Sidebar Toggle Placement and Responsive State"
date: 2026-08-10
category: ui-bugs
module: "apps/mail sidebar navigation (NavUser, MailLayout, SidebarToggle)"
problem_type: ui_bug
component: frontend_stimulus
severity: low
symptoms:
  - "Session report: desktop sidebar hide/show control appeared beside Hide inbox instead of sidebar actions."
  - "Expanded NavUser requires a trailing sidebar control in the account/navigation row."
  - "Collapsed-desktop and mobile sidebar opening paths require focused contract coverage after placement changes."
root_cause: logic_error
resolution_type: code_fix
related_components:
  - testing_framework
tags:
  - mail
  - sidebar-toggle
  - nav-user
  - mobile-sidebar
  - responsive-navigation
  - accessibility
  - source-contract
  - ec2-pilot
---

# Mail Sidebar Toggle Placement and Responsive State

## Problem

Session report: the mail SPA placed sidebar visibility beside the unrelated **Hide inbox** action. The two controls affect different surfaces: inbox collapse changes the wide mail-list panel, while sidebar visibility changes application navigation.

## Symptoms

- The reported desktop grouping put sidebar visibility with mail-list controls instead of the navigation account row.
- The collapsed sidebar still needed a reachable reopen control below its account avatar.
- Mobile needed one page-toolbar opener that reflects drawer state, not persisted desktop sidebar state.
- Directional chevrons use explicit `h-3 w-3` sizing.

## What Didn't Work

- The original placement beside **Hide inbox** was rejected because it visually conflated two independent actions. The old DOM is not retained in the current tree; this is session evidence from the reported UX defect.
- Reading only desktop `open` state on mobile would misreport the control state. `toggleSidebar` mutates `openMobile` on mobile and `open` elsewhere (`apps/mail/components/context/sidebar-context.tsx:75-78`).
- Earlier mail-shell work showed that an expand affordance must remain outside a collapsed surface; it also found that a wide-panel collapse can be a no-op when its sibling cannot grow. That is adjacent **Hide inbox** behavior, not a reason to reuse its control for sidebar navigation. (session history)

## Solution

Make `SidebarToggle` state-aware for both responsive modes:

```tsx
const isOpen = isMobile ? openMobile : open;
const label = isOpen ? 'Hide sidebar' : 'Show sidebar';
```

The same component calls `toggleSidebar`, sets `aria-expanded`, `aria-label`, `data-state`, an SR-only label, and renders `ChevronLeft` for open / `ChevronRight` for closed. Both chevrons use explicit `h-3 w-3` sizing (`apps/mail/components/ui/sidebar-toggle.tsx:9-38`).

Place controls by their owner:

- Expanded desktop: exactly one `SidebarToggle` ends `NavUser`'s top row after the `ThreeDots` Debug/Logout menu (`apps/mail/components/ui/nav-user.tsx:405-591`).
- Collapsed desktop: retain one opener below the account-avatar dropdown (`apps/mail/components/ui/nav-user.tsx:262-404`).
- Mobile: retain one `md:hidden` opener in the mail toolbar before the separate **Hide inbox** control (`apps/mail/components/mail/mail.tsx:512-533`).

Lock those constraints with `apps/mail/tests/sidebar-toggle-placement.test.ts`. It reads source and asserts the responsive state expression, accessibility attributes, directional icons, placement after `ThreeDots`, collapsed opener, and the sole mobile toolbar opener (`apps/mail/tests/sidebar-toggle-placement.test.ts:11-78`).

## Why This Works

`SidebarProvider` keeps desktop and mobile sidebar state separate, and `toggleSidebar` chooses the mutation path from `isMobile` (`apps/mail/components/context/sidebar-context.tsx:53-78`). Deriving display state from the same condition prevents a mobile drawer from showing a stale desktop label.

The new placement makes the UI hierarchy truthful: navigation visibility belongs with navigation controls, while wide-split inbox collapse remains in the mail-list toolbar. The source contract asserts the current toggle counts and ordering, flagging changes to those source patterns.

## Prevention

- Keep `apps/mail/tests/sidebar-toggle-placement.test.ts` green whenever sidebar, `NavUser`, or mail-toolbar JSX changes.
- Treat sidebar visibility and **Hide inbox** as separate control families; do not co-locate them merely because both use directional icons.
- For a responsive toggle, derive both mutation and rendered state from the same viewport branch.
- Before Vitest, unset `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS`; the sidebar source contract is database-independent.

## Related Issues

- [Mail Close Empty Pane Mid-Width and Panel Collapse](./mail-close-empty-pane-mid-width.md) — related mail-shell collapse work; its historical sidebar-icon/placement text needs a targeted refresh.
- [Mail Reply Inbox List Horizontal Shift on Narrow Viewport](./mail-reply-inbox-list-horizontal-shift.md) — adjacent responsive mail-shell containment and source-contract practice.
