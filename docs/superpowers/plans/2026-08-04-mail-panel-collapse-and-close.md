# Mail Panel Collapse + Close-to-Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Close/X on narrow desktop so staff return to the inbox list (not "It's empty here"), and add on-theme sidebar + inbox collapse controls using libraries already in the mail app.

**Architecture:** Keep the existing three-surface model (nav `AppSidebar` cookie collapse, list+thread `react-resizable-panels` split, mobile thread overlay). Below `lg`, mount the desktop thread panel only when `threadId` is set so Close unmounts reading chrome and leaves list-only. At `lg+`, make the list panel `collapsible` with an imperative toggle; when collapsed, migrate the expand control into the thread header so it is never trapped inside a zero-width panel. Stay on `react-resizable-panels@2.1.7` (do not upgrade to v4).

**Tech Stack:** React Router mail shell, `nuqs` `threadId`, `react-resizable-panels@2.1.7`, custom `icons.tsx` panel glyphs, existing `Button`/`Tooltip`, CSS transitions only for chrome, Vitest source contracts (no pilot RDS).

## Global Constraints

- Never run Vitest with `DATABASE_URL` on pilot RDS; always `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` first.
- Preserve `min-w-0` on list/thread panels (see `docs/solutions/ui-bugs/mail-reply-inbox-list-horizontal-shift.md`).
- Close/unmount must not race compose draft flush (`docs/solutions/logic-errors/compose-close-draft-honesty.md`).
- No new panel library; no Lucide panel icons next to custom fill siblings; no purple/glow/card chrome.
- No DESIGN.md rewrite — chrome-only within existing Centurion mail shell.

---

## Nava-plan gate status

| Gate | Status |
|------|--------|
| Evidence + solutions | Done |
| Exa research (rrp collapsible + Outlook/Gmail patterns) | Done |
| Eng review (completeness) | Done — APPROVE WITH REQUIRED ADDITIONS |
| Ponytail review (simplicity) | Done — Cut 4 speculative pieces |
| Design review (UI chrome) | Done — locked spec below |
| Reconcile | Done — see Decisions |
| Final artifact | This file |

**Prior incomplete pass:** First CreatePlan only. Missing `docs/superpowers/plans/` artifact, paired reviews, Exa, design lock. This file is the corrected final plan.

---

## Decisions (reconciled)

1. **Close-to-inbox (requirement):** Mid-width (`md`–`<lg`): desktop thread panel mounts **only if** `threadId`. Close → `setThreadId(null)` after compose flush → list-only. `lg+`: empty reading pane when nothing selected is OK (Outlook-style).
2. **No CSS `hidden` on ResizablePanel for mid-width list:** Prefer conditional mount / single-panel layout over `hidden lg:block` (eng: flex/% + persistence fight).
3. **`autoSaveId`:** Bump to `mail-split-v3`. Mid-width changes panel count; old `mail-split-v2` layouts are unsafe. Disable `autoSaveId` when not wide-split (single panel), or only enable autoSave at `lg+`.
4. **List collapse:** `collapsible` + `ref.collapse()`/`expand()` on `mail-list-panel`, `lg+` only. Imperative button is primary; drag-to-collapse via half-`minSize` threshold is acceptable library behavior — document in smoke, do not add second persistence path.
5. **Expand control ownership (eng CRITICAL + design):** When list expanded, collapse button sits **immediate right of** `SidebarToggle` in list header. When list collapsed, **same control migrates** to thread header slot 0 (left of Close). Never only inside collapsed panel. `collapsedSize={0}` full collapse (no mini peek strip).
6. **SidebarToggle polish kept** (design + user ask beat ponytail cut): state-true icon, tooltip, `aria-expanded`. Still **one** sidebar control — no duplicate.
7. **Ponytail cuts applied:** No separate `mail-list-collapse-button.tsx`. No `localStorage mail-list-collapsed` unless smoke proves `autoSaveId` insufficient. Keep small pure helper module **only** because Close regression needs unit matrix (eng completeness > one-caller YAGNI).
8. **Icons:** Add `PanelLeftClose` (and list twin if needed) in `apps/mail/components/icons/icons.tsx` matching `PanelLeftOpen` fill language. Reject Lucide `PanelLeftClose` beside custom fill.
9. **Motion:** CSS `transition-colors duration-150` only for chrome. Ban `motion` springs on panel width (fights rrp layout). Keep existing `motion` in thread content untouched.
10. **Stay on rrp 2.1.7.** Exa confirms v4 breaking (rename Separator, overflow wrapper). No upgrade in this plan.

---

## Design spec (locked)

| Token | Value |
|-------|--------|
| Surfaces | `bg-panelLight dark:bg-panelDark`, `rounded-2xl shadow-sm` |
| Icon fill | `fill-iconLight dark:fill-iconDark` |
| Controls | `Button variant="ghost"` `h-10 w-10 rounded-lg` `hover:bg-accent/50` (match Refresh) |
| Cluster | `[SidebarToggle] [ListCollapse] | Search … | Category | Refresh` — `gap-2`, no second toolbar |
| Tooltips | `delayDuration={0}` — "Hide sidebar"/"Show sidebar"; "Hide inbox"/"Show inbox" |
| a11y | `aria-expanded` + `sr-only` on both toggles |
| Anti-slop | No purple/glow/gradient, no cards, no FAB, no edge tab card, no emoji |

Outlook/Gmail research (Exa): folder pane toggles via one chrome control; reading pane off returns to message list; collapsed panels need an external reopen target (rrp docs: keep Separator / external control). Our migrate-to-thread-header matches that.

---

## Breakpoint × chrome matrix

| Viewport | List panel | Thread panel | Resize handle | List collapse btn | Expand (list gone) | Close effect |
|----------|------------|--------------|---------------|-------------------|--------------------|--------------|
| `<768` | full | mobile overlay iff `threadId` | n/a | hidden | n/a | clear id → overlay gone |
| `768–1023` | full iff `!threadId`; unmount/hide when open | mount iff `threadId` | hidden when single panel | hidden | n/a | clear id → list only, no empty pane |
| `≥1024` | collapsible split | always (empty OK) | shown when list expanded | list header | migrates to thread header | clear selection; empty pane OK |

Hotkeys: when list collapsed at `lg+`, keep thread hotkey scope; do not leave list-nav shortcuts driving invisible UI.

---

## Root cause

User said "Nothing to see here"; UI copy is **"It's empty here"** in `thread-display.tsx` when `!id`. Mid-width: list gets `hidden lg:block` while thread stays mounted → Close clears `threadId` → empty reading chrome.

---

## Files

| Path | Role |
|------|------|
| `apps/mail/lib/mail/mail-panel-visibility.ts` | Pure helpers for matrix |
| `apps/mail/tests/mail-panel-visibility.test.ts` | Unit matrix |
| `apps/mail/components/mail/mail.tsx` | Mount rules, collapsible list, header controls, autoSave v3 |
| `apps/mail/components/ui/sidebar-toggle.tsx` | State-true icon + tooltip + a11y |
| `apps/mail/components/icons/icons.tsx` | Add `PanelLeftClose` (+ list twin if needed) |
| `apps/mail/components/mail/thread-display.tsx` | Optional: accept `listCollapsed` + expand slot prop **or** portal expand from `mail.tsx` sibling — prefer expand button rendered by `mail.tsx` over thread when collapsed to avoid prop drilling if simple |
| `apps/mail/tests/mail-shell-overflow-contract.test.ts` | Extend: `min-w-0`, expand-outside-list, no duplicate sidebar toggle, `mail-split-v3` |

---

### Task 1: Visibility helpers + failing tests

**Files:**
- Create: `apps/mail/lib/mail/mail-panel-visibility.ts`
- Create: `apps/mail/tests/mail-panel-visibility.test.ts`

**Interfaces:**
```ts
export function shouldShowDesktopThreadPanel(args: {
  isDesktop: boolean;
  isWideSplit: boolean;
  threadId: string | null;
}): boolean;

export function shouldShowDesktopListPanel(args: {
  isDesktop: boolean;
  isWideSplit: boolean;
  threadId: string | null;
}): boolean;

export function shouldShowMailSplitHandle(args: {
  isWideSplit: boolean;
  listCollapsed: boolean;
  threadMounted: boolean;
  listMounted: boolean;
}): boolean;
```

- [x] **Step 1: Write failing tests** covering matrix cells: mid+threadId → thread yes list no; mid+null → thread no list yes; lg+ null → both yes; `<md` desktop thread never; handle hidden when single panel or listCollapsed.

- [x] **Step 2: Run** — RED confirmed (module missing).

- [x] **Step 3: Implement helpers** to make tests pass.

- [x] **Step 4: Re-run** — 12/12 green.

- [ ] **Step 5: Commit** — skipped (`/nava-run` does not authorize commits unless user asks).

---

### Task 2: Close-to-inbox shell wiring

**Files:**
- Modify: `apps/mail/components/mail/mail.tsx`
- Modify: `apps/mail/tests/mail-shell-overflow-contract.test.ts`

**Notes:**
- `isWideSplit = useMediaQuery('(min-width: 1024px)')`.
- Mount desktop thread only when `shouldShowDesktopThreadPanel(...)`.
- Mount list when `shouldShowDesktopListPanel(...)` (avoid CSS `hidden` on ResizablePanel).
- Keep `order` + stable `id`s; when panel count changes, use `autoSaveId={isWideSplit ? 'mail-split-v3' : undefined}`.
- Preserve `min-w-0`; never `w-fit`.
- Mobile overlay path unchanged.
- Close path: existing `handleClose` in thread-display already `await clearComposeContext()` then `setThreadId(null)` — do not unmount parent before that settles (already sequential inside ThreadDisplay; do not add a racing parent clear).

- [x] **Step 1: Extend overflow contract** for `mail-split-v3` and absence of `hidden lg:block` on list panel (or assert helpers used).

- [x] **Step 2: Run contract test** — RED then green after wire.

- [x] **Step 3: Wire mail.tsx** mount rules + autoSave bump.

- [x] **Step 4: Run** visibility + overflow tests — 19/19 green.

- [ ] **Step 5: Commit** — skipped (no commit auth).

---

### Task 3: Custom PanelLeftClose + SidebarToggle polish

**Files:**
- Modify: `apps/mail/components/icons/icons.tsx`
- Modify: `apps/mail/components/ui/sidebar-toggle.tsx`

- [x] **Step 1: Add `PanelLeftClose`** same optical size/fill language as `PanelLeftOpen`.

- [x] **Step 2: SidebarToggle** — state-true icon, tooltip, `aria-expanded`.

- [x] **Step 3:** When list collapsed, SidebarToggle migrates into thread chrome with expand (nav still reachable).

- [ ] **Step 4: Commit** — skipped (no commit auth).

---

### Task 4: Inbox list collapse + migrating expand control

**Files:**
- Modify: `apps/mail/components/mail/mail.tsx`
- Possibly thin markup in thread header area from parent (preferred: when `listCollapsed`, render expand `Button` as first control overlay/sibling in thread panel chrome without deep thread-display API — if that is awkward, pass `onExpandList` + `showExpandList` into `ThreadDisplay` header)

**rrp 2.1.7 API (locked):**
```ts
const listRef = useRef<ImperativePanelHandle>(null);
// Panel: collapsible, collapsedSize={0}, ref={listRef}
// onCollapse / onExpand → setListCollapsed boolean for chrome migration
listRef.current?.collapse();
listRef.current?.expand();
```

- [x] **Step 1: Source-contract asserts** — `data-mail-list-expand` after thread panel id.

- [x] **Step 2: Implement** list `collapsible`, header Hide inbox (`lg+`), migrate expand + SidebarToggle into thread chrome when collapsed, handle gated by helper.

- [x] **Step 3: Run** all mail shell tests — 19/19 green.

- [ ] **Step 4: Commit** — skipped (no commit auth).

---

### Task 5: Verification

- [x] **Step 1:** Vitest 19/19 pass after `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`.

- [ ] **Step 2: Manual smoke checklist** — staff/browser (not automated here):
  - Width ~900px: open mail → Close/X → inbox list only; **no** "It's empty here".
  - Width ~900px + dirty reply: Close still flushes/honest draft path.
  - Width ≥1024: list collapse → expand from thread chrome → list returns.
  - Sidebar toggle icon flips; cookie persists.

- [x] **Step 3:** List collapsed migrates both SidebarToggle + list expand into thread chrome.

- [x] **Step 4: CE note:** `docs/solutions/ui-bugs/mail-close-empty-pane-mid-width.md`.

---

## Review disposition

| Review | Result | Applied |
|--------|--------|---------|
| Eng | APPROVE + CRITICAL additions | autoSave v3, expand outside list, compose flush note, matrix, no CSS hidden |
| Ponytail | Cut 4 | dropped separate button file, localStorage default, DESIGN.md work; kept helper for regression tests; kept SidebarToggle polish (user/design override) |
| Design | Locked chrome spec | custom icons, CSS motion, migrate expand, ghost cluster |
| Exa | rrp collapsible + Outlook/Gmail | stay 2.1.7; external reopen control; Close = return to list |

**Conflict:** Ponytail cut SidebarToggle polish; Design + user asked for nice/intuitive sidebar control. **Resolution:** keep polish, still one control.

## Unresolved blockers

None for planning. Execution blocker only if `SidebarRail` cannot restore nav when list collapsed — Task 5 Step 3 resolves by migrating both toggles into thread header.

## Next step

`/nava-run` on `docs/superpowers/plans/2026-08-04-mail-panel-collapse-and-close.md`.
