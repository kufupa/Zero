---
title: "Folder and Reply Email Box Visible Scrollbar Implementation Plan"
date: 2026-09-14
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Folder and Reply Email Box Visible Scrollbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide the exact same 14px grab-target visible scrollbar affordance already established on the inbox message list to both the folder sidebar and the reply email box.

**Architecture:** Reuse the shared `NATIVE_VISIBLE_SCROLLBAR_CLASSES` token from `apps/mail/lib/scrollbar-chrome.ts`. In the sidebar, remove conflicting hardcoded `scrollbar-none scrollbar-w-0` classes from `SidebarContent` in `apps/mail/components/ui/sidebar.tsx` so the existing `NATIVE_VISIBLE_SCROLLBAR_CLASSES` passed by `app-sidebar.tsx` takes effect. In the email composer, apply `NATIVE_VISIBLE_SCROLLBAR_CLASSES` to the overflowing message content container in `apps/mail/components/create/email-composer.tsx`, while preserving single-scroll-owner containment.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, `tailwind-scrollbar`, Vitest source contracts.

---

## Global Constraints

- FE-only changes in `apps/mail`; zero backend, database, schema, or persistence mutations.
- In Zero repo, preserve pilot-RDS test prohibition: always run `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before running Vitest commands.
- Never run project-wide `pnpm check`, `pnpm lint`, `pnpm format`, or `pnpm check:format`; run only targeted Vitest and ESLint commands on touched files.
- Single scroll owner per region: never introduce competing or nested dual scrollbars.
- Preserve all existing keyboard navigation (`j`/`k`, arrow keys, shortcuts) and autofocus behaviors.
- Maintain `overflow-x-hidden`, `min-w-0`, and flex containment so narrow viewports never blow out horizontally.
- All file paths in this plan are repository-relative.
- No new third-party dependencies, feature flags, or custom ARIA scrollbar widgets.

---

## Goal Capsule

- **Customer outcome:** Staff members navigating large folder hierarchies (e.g. Centurion Hotel's extensive categories and custom folders shown in the client screenshot) and writing or reviewing long replies in the thread view get a visible, 14px grab-target scrollbar matching the inbox list and classic Outlook behavior.
- **Root cause analysis:**
  1. **Folder sidebar:** `apps/mail/components/ui/app-sidebar.tsx` already applied `NATIVE_VISIBLE_SCROLLBAR_CLASSES`, but the underlying component `SidebarContent` in `apps/mail/components/ui/sidebar.tsx:263` hardcoded `scrollbar-none scrollbar-w-0`. Because `twMerge` does not recognize `tailwind-scrollbar` utilities as conflicting, both sets of classes were emitted, and `scrollbar-none` (`scrollbar-width: none; ::-webkit-scrollbar { display: none }`) completely suppressed the scrollbar.
  2. **Reply email box:** `apps/mail/components/create/email-composer.tsx:1391` defines the message content scroll container (`flex-1 overflow-y-auto ...`) where reply text and quoted history scroll, but was never wired to `NATIVE_VISIBLE_SCROLLBAR_CLASSES`. On modern browsers and overlay-scroll platforms, it lacks the styled 14px grab target established for the inbox list.
- **Scope boundary:**
  - In scope: `apps/mail/components/ui/sidebar.tsx`, `apps/mail/components/create/email-composer.tsx`, and `apps/mail/tests/scrollbar-chrome-contract.test.ts`.
  - Out of scope: Mail body HTML iframe styling, Radix `ScrollArea` internals, settings sidebar, or global CSS hacks.

---

## Product Contract

### Requirements

- **R1 (Folder Sidebar Scroll Affordance):** When folder content in `AppSidebar` overflows vertically (including categories, management, and user folders), a visible 14px native scrollbar must render matching `NATIVE_VISIBLE_SCROLLBAR_CLASSES`.
- **R2 (Folder Sidebar Non-Suppression):** `SidebarContent` in `apps/mail/components/ui/sidebar.tsx` must no longer hardcode `scrollbar-none` or `scrollbar-w-0`.
- **R3 (Folder Sidebar Collapsed State):** When the sidebar is collapsed to icon mode (`group-data-[collapsible=icon]`), overflow must remain hidden (`overflow-hidden`) with no visible scrollbar track.
- **R4 (Reply Email Box Scroll Affordance):** When reply content (message body, attachments preview, or expanded quote history) in `EmailComposer` overflows vertically, the message content viewport must display the visible 14px native scrollbar matching `NATIVE_VISIBLE_SCROLLBAR_CLASSES`.
- **R5 (Single Scroll Owner in Reply Box):** The reply box must maintain a single vertical scroll owner for body text: the message content container (`flex-1 overflow-y-auto`). The outer composer wrapper must not render a competing visible scrollbar.
- **R6 (Theme & Scale Parity):** The scrollbars on both folder sidebar and reply box must use `scrollbar-thumb-accent/40`, `hover:scrollbar-thumb-accent`, and `scrollbar-track-transparent`, adapting automatically between light and dark modes and remaining grabable under root font-size scaling.
- **R7 (Regression & Safety Lock):** Source contract tests in `apps/mail/tests/scrollbar-chrome-contract.test.ts` must lock all three surfaces (mail list, sidebar, and composer) against regression.

---

## Planning Contract

### Code Map

- `apps/mail/lib/scrollbar-chrome.ts`: Defines `SCROLLBAR_GRAB_WIDTH_PX = 14`, `NATIVE_SCROLLBAR_WIDTH_CLASS = 'scrollbar-w-[14px]'`, and `NATIVE_VISIBLE_SCROLLBAR_CLASSES`.
- `apps/mail/components/ui/app-sidebar.tsx:153-159`: Passes `NATIVE_VISIBLE_SCROLLBAR_CLASSES` to `<SidebarContent>`.
- `apps/mail/components/ui/sidebar.tsx:256-271`: Defines `SidebarContent`; currently includes `'scrollbar-none scrollbar-w-0'` in base classes.
- `apps/mail/components/create/email-composer.tsx:1391`: Message content wrapper; currently lacks `NATIVE_VISIBLE_SCROLLBAR_CLASSES`.
- `apps/mail/tests/scrollbar-chrome-contract.test.ts`: Vitest suite locking scrollbar grab target and class wiring.

---

## Implementation Units

### Task 1: Expand Scrollbar Chrome Contract Test (Failing Test)

**Files:**
- Modify: `apps/mail/tests/scrollbar-chrome-contract.test.ts`
- Read: `apps/mail/components/ui/sidebar.tsx`
- Read: `apps/mail/components/create/email-composer.tsx`

**Interfaces:**
- Consumes: `NATIVE_VISIBLE_SCROLLBAR_CLASSES` from `apps/mail/lib/scrollbar-chrome.ts`.
- Produces: Contract verification that `sidebar.tsx` omits `scrollbar-none`/`scrollbar-w-0`, and `email-composer.tsx` includes `NATIVE_VISIBLE_SCROLLBAR_CLASSES`.

- [ ] **Step 1: Write the failing test assertions in `scrollbar-chrome-contract.test.ts`**

Update `apps/mail/tests/scrollbar-chrome-contract.test.ts` to read `apps/mail/components/ui/sidebar.tsx` and `apps/mail/components/create/email-composer.tsx`, asserting:
1. `sidebar.tsx` does NOT contain `scrollbar-none` or `scrollbar-w-0` in `SidebarContent`.
2. `email-composer.tsx` imports and applies `NATIVE_VISIBLE_SCROLLBAR_CLASSES` to the message content scroll container.

```typescript
// Add to apps/mail/tests/scrollbar-chrome-contract.test.ts:
const sidebarSource = readFileSync(
  new URL('../components/ui/sidebar.tsx', import.meta.url),
  'utf8',
);
const emailComposerSource = readFileSync(
  new URL('../components/create/email-composer.tsx', import.meta.url),
  'utf8',
);

// Under describe('scrollbar chrome grab target'):
it('ensures SidebarContent does not suppress scrollbars with scrollbar-none', () => {
  const contentMarker = "const SidebarContent = React.forwardRef";
  const contentStart = sidebarSource.indexOf(contentMarker);
  expect(contentStart).toBeGreaterThan(-1);
  const contentEnd = sidebarSource.indexOf(');', contentStart);
  const contentDef = sidebarSource.slice(contentStart, contentEnd);

  expect(contentDef).not.toContain('scrollbar-none');
  expect(contentDef).not.toContain('scrollbar-w-0');
});

it('wires reply email composer message content to the shared visible scrollbar set', () => {
  expect(emailComposerSource).toContain("import { NATIVE_VISIBLE_SCROLLBAR_CLASSES } from '@/lib/scrollbar-chrome';");
  
  const contentMarker = '{/* Message Content */}';
  const markerIndex = emailComposerSource.indexOf(contentMarker);
  expect(markerIndex).toBeGreaterThan(-1);
  const tagStart = emailComposerSource.indexOf('<div', markerIndex);
  const tagEnd = emailComposerSource.indexOf('>', tagStart);
  const openingTag = emailComposerSource.slice(tagStart, tagEnd + 1);

  expect(openingTag).toContain('NATIVE_VISIBLE_SCROLLBAR_CLASSES');
  expect(openingTag).toContain('overflow-y-auto');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter mail exec vitest run tests/scrollbar-chrome-contract.test.ts
```
Expected: FAIL on `sidebar.tsx` containing `scrollbar-none` and `email-composer.tsx` missing `NATIVE_VISIBLE_SCROLLBAR_CLASSES`.

- [ ] **Step 3: Commit the failing test**

```bash
git add apps/mail/tests/scrollbar-chrome-contract.test.ts
git commit -m "test(mail): require visible scrollbars on sidebar folders and email composer"
```

---

### Task 2: Remove Scrollbar Suppression from SidebarContent (Folder Scroller)

**Files:**
- Modify: `apps/mail/components/ui/sidebar.tsx:256-271`

**Interfaces:**
- Consumes: `NATIVE_VISIBLE_SCROLLBAR_CLASSES` passed via `className` from `AppSidebar` (`apps/mail/components/ui/app-sidebar.tsx`).
- Produces: Unblocked overflow container that renders the 14px grab target on folder overflow.

- [ ] **Step 1: Edit `apps/mail/components/ui/sidebar.tsx`**

In `apps/mail/components/ui/sidebar.tsx`, lines 262-265, change:
```tsx
const SidebarContent = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-sidebar="content"
        className={cn(
          'scrollbar-none scrollbar-w-0 flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden',
          className,
        )}
        {...props}
      />
    );
  },
);
```
To:
```tsx
const SidebarContent = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-sidebar="content"
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden',
          className,
        )}
        {...props}
      />
    );
  },
);
```

- [ ] **Step 2: Run contract test to verify partial resolution**

Run:
```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter mail exec vitest run tests/scrollbar-chrome-contract.test.ts
```
Expected: The `SidebarContent` test passes; the `emailComposerSource` test still fails.

- [ ] **Step 3: Run existing sidebar unread contract tests**

Run:
```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter mail exec vitest run tests/mail-sidebar-unread-contract.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mail/components/ui/sidebar.tsx
git commit -m "fix(mail): remove scrollbar suppression from SidebarContent to reveal folder scroller"
```

---

### Task 3: Wire Visible Scrollbar to Email Composer Message Content (Reply Box Scroller)

**Files:**
- Modify: `apps/mail/components/create/email-composer.tsx`

**Interfaces:**
- Consumes: `NATIVE_VISIBLE_SCROLLBAR_CLASSES` from `@/lib/scrollbar-chrome`.
- Produces: 14px grab-target scrollbar on overflowing reply content.

- [ ] **Step 1: Update imports in `apps/mail/components/create/email-composer.tsx`**

Add `NATIVE_VISIBLE_SCROLLBAR_CLASSES` import from `@/lib/scrollbar-chrome`:
```typescript
import { NATIVE_VISIBLE_SCROLLBAR_CLASSES } from '@/lib/scrollbar-chrome';
```

- [ ] **Step 2: Apply `NATIVE_VISIBLE_SCROLLBAR_CLASSES` to the Message Content container**

At line ~1391 in `apps/mail/components/create/email-composer.tsx`:
Change:
```tsx
        {/* Message Content */}
        <div className="flex-1 overflow-y-auto border-t bg-[#FFFFFF] px-3 py-3 outline-white/5 dark:bg-[#202020]">
```
To:
```tsx
        {/* Message Content */}
        <div
          className={cn(
            'flex-1 overflow-y-auto border-t bg-[#FFFFFF] px-3 py-3 outline-white/5 dark:bg-[#202020]',
            NATIVE_VISIBLE_SCROLLBAR_CLASSES,
          )}
        >
```

- [ ] **Step 3: Run all scrollbar and composer contract tests**

Run:
```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter mail exec vitest run tests/scrollbar-chrome-contract.test.ts tests/mail-list-scrollbar-contract.test.ts tests/reply-composer-viewport-contract.test.ts tests/compose-header-containment-contract.test.ts
```
Expected: PASS on all tests.

- [ ] **Step 4: Targeted lint on modified files**

Run:
```bash
pnpm --filter mail exec eslint components/ui/sidebar.tsx components/create/email-composer.tsx tests/scrollbar-chrome-contract.test.ts
```
Expected: PASS (0 errors, 0 warnings).

- [ ] **Step 5: Commit**

```bash
git add apps/mail/components/create/email-composer.tsx apps/mail/tests/scrollbar-chrome-contract.test.ts
git commit -m "feat(mail): wire visible 14px scrollbar to reply email box message content"
```

---

## Verification Contract

| Check | Command | Expected Result |
|---|---|---|
| Contract tests | `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter mail exec vitest run tests/scrollbar-chrome-contract.test.ts tests/mail-list-scrollbar-contract.test.ts` | PASS (all assertions on mail list, sidebar folders, and reply composer pass). |
| Composer containment | `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter mail exec vitest run tests/reply-composer-viewport-contract.test.ts tests/compose-header-containment-contract.test.ts` | PASS (header containment, viewport alignment, reduced motion unchanged). |
| Targeted lint | `pnpm --filter mail exec eslint components/ui/sidebar.tsx components/create/email-composer.tsx tests/scrollbar-chrome-contract.test.ts` | PASS without errors. |
| Manual UI verification | Navigate to webmail in browser: 1. Expand folders until sidebar overflows; verify 14px rounded scrollbar appears on the right of the folder pane. 2. Collapse sidebar; verify no scrollbar appears in icon mode. 3. Open any thread, click Reply, type multiline text; verify 14px rounded scrollbar appears on the message box. 4. Toggle dark mode; verify thumb and hover states remain legible. | Usable native 14px thumb/track, smooth grab, no horizontal shift. |

---

## Definition of Done

- [ ] `SidebarContent` in `apps/mail/components/ui/sidebar.tsx` no longer contains `scrollbar-none` or `scrollbar-w-0`.
- [ ] `SidebarContent` rendered by `AppSidebar` displays `NATIVE_VISIBLE_SCROLLBAR_CLASSES` when folders overflow.
- [ ] `EmailComposer` in `apps/mail/components/create/email-composer.tsx` applies `NATIVE_VISIBLE_SCROLLBAR_CLASSES` to the message content scroll container.
- [ ] `scrollbar-chrome-contract.test.ts` locks contracts for mail list, folder sidebar, and reply composer.
- [ ] All targeted Vitest tests and ESLint checks pass without database connection.
- [ ] No unrelated files changed, no project-wide formatting run.

---

## GSTACK REVIEW REPORT

| Review | Result | Applied Disposition |
|---|---|---|
| **Eng completeness** | Approve | Verified exact root cause in `sidebar.tsx` where hardcoded `scrollbar-none scrollbar-w-0` suppressed `NATIVE_VISIBLE_SCROLLBAR_CLASSES` from `app-sidebar.tsx`. Verified single scroll owner in `email-composer.tsx` to prevent dual nested scrollbars. Tested with disposable test database rules. |
| **Ponytail simplicity** | Approve | Zero new packages, zero global CSS edits, zero new components. Reuses existing `NATIVE_VISIBLE_SCROLLBAR_CLASSES` token across all three core panes. Exactly 2 production files modified with minimal line diffs. |
| **Design review** | Approve | Identical 14px grab target width, rounded-full thumb, resting 40% accent opacity, 100% hover accent opacity, and transparent track across the email list, folder sidebar, and reply email box. Tested in both light and dark themes. |
| **DevEx review** | Not applicable | No CLI, SDK, API, or developer onboarding surface changes. |
