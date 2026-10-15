# Ctrl + A (Select All) While Email Is Open - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `Ctrl + A` (`mod + a`) Select All shortcut in Nava so that pressing `Ctrl + A` reliably selects all emails in the active folder even when an email is currently open on screen, and ensures bulk action shortcuts (`d`, `r`, `u`, `e`, `Escape`) function properly once emails are selected.

**Architecture:** 
1. Register `selectAll` (`mod + a`) in both `mail-list` and `thread-display` scopes in [shortcuts.ts](file:///home/ubuntu/projects/zero/apps/mail/config/shortcuts.ts).
2. Wire the `selectAll` handler into [thread-display-hotkeys.tsx](file:///home/ubuntu/projects/zero/apps/mail/lib/hotkeys/thread-display-hotkeys.tsx) using `useThreads` and `useMail`, matching the behavior in [mail-list-hotkeys.tsx](file:///home/ubuntu/projects/zero/apps/mail/lib/hotkeys/mail-list-hotkeys.tsx).
3. Update scope switching in [mail.tsx](file:///home/ubuntu/projects/zero/apps/mail/components/mail/mail.tsx) so that whenever `mail.bulkSelected.length > 0`, `mail-list` scope is active (allowing bulk operations like delete, mark read, archive, and deselect), transitioning back to `thread-display` when selection is cleared.
4. Verify form safety (`enableOnFormTags: false` and `enableOnContentEditable: false` ensure `Ctrl + A` selects text inside reply composers or search inputs).

**Tech Stack:** React, TypeScript, Jotai, `react-hotkeys-hook`, `nuqs`, Vitest, Testing Library.

---

## Global Constraints

- **No Code Without Approval**: Do NOT implement code until this plan artifact has been explicitly reviewed and approved by the user.
- **Form / Editor Protection**: Pressing `Ctrl + A` while typing in a reply box, search input, or any text editor MUST select text in that editor, never trigger inbox email selection.
- **Clean Scope Transition**: `r` and `a` in `thread-display` MUST continue to mean `Reply` and `Reply All` when viewing a single thread with no bulk selection. When bulk selection is active (`mail.bulkSelected.length > 0`), `mail-list` scope takes precedence so `r` marks as read, `d` bulk deletes, and `Escape` exits selection mode.
- **Responsive Parity**: Must work identically on wide desktop split view (screen width $\ge$ 1024px) and single pane/mobile view.

---

## Root Cause Analysis

In [apps/mail/components/mail/mail.tsx:406-420](file:///home/ubuntu/projects/zero/apps/mail/components/mail/mail.tsx#L406-L420):
```typescript
useEffect(() => {
  const listHidden = Boolean(threadId) || (isWideSplit && listCollapsed);
  if (listHidden) {
    enableScope('thread-display');
    disableScope('mail-list');
  } else {
    enableScope('mail-list');
    disableScope('thread-display');
  }
  return () => {
    disableScope('thread-display');
    disableScope('mail-list');
  };
}, [threadId, isWideSplit, listCollapsed, enableScope, disableScope]);
```

1. As soon as an email is opened (`threadId` is present in query parameters), `Boolean(threadId)` is `true`, so `disableScope('mail-list')` and `enableScope('thread-display')` execute.
2. In [apps/mail/config/shortcuts.ts](file:///home/ubuntu/projects/zero/apps/mail/config/shortcuts.ts), `selectAll` (`mod + a`) is only defined in `mailListShortcuts` (`scope: 'mail-list'`).
3. `threadDisplayShortcuts` has no shortcut for `mod + a`.
4. [apps/mail/lib/hotkeys/thread-display-hotkeys.tsx](file:///home/ubuntu/projects/zero/apps/mail/lib/hotkeys/thread-display-hotkeys.tsx) has no handler for `selectAll`.
5. Result: Pressing `Ctrl + A` while an email is open is completely ignored by Nava; the browser falls back to selecting all text on the webpage.
6. Furthermore, if a user `Ctrl + Click`s emails in the mail list while an email is open, `threadId` remains in the URL, keeping `mail-list` disabled. Consequently, `d` (bulk delete), `r` (mark read), `Escape` (exit selection), and `Ctrl + A` remain dead.

---

## File Structure & Responsibilities

- **Modify:** [apps/mail/config/shortcuts.ts](file:///home/ubuntu/projects/zero/apps/mail/config/shortcuts.ts)
  - Add `mod + a` (`selectAll`) to `threadDisplayShortcuts` so `react-hotkeys-hook` recognizes `Ctrl + A` when `thread-display` scope is active.
- **Modify:** [apps/mail/lib/hotkeys/thread-display-hotkeys.tsx](file:///home/ubuntu/projects/zero/apps/mail/lib/hotkeys/thread-display-hotkeys.tsx)
  - Implement `selectAll` handler using `useThreads()` and `useMail()`, toggling selection of loaded items.
- **Modify:** [apps/mail/components/mail/mail.tsx](file:///home/ubuntu/projects/zero/apps/mail/components/mail/mail.tsx)
  - Update the scope effect so that whenever `mail.bulkSelected.length > 0`, `mail-list` scope is enabled and `thread-display` is disabled, allowing bulk actions on the selected items.
- **Create:** [apps/mail/tests/ctrl-a-shortcut.test.tsx](file:///home/ubuntu/projects/zero/apps/mail/tests/ctrl-a-shortcut.test.tsx)
  - Vitest test suite testing shortcut definitions, handler execution in both scopes, and scope switching with open threads.

---

## Tasks

### Task 1: Add `selectAll` Shortcut Definition to `thread-display` Scope

**Files:**
- Modify: [apps/mail/config/shortcuts.ts:82-125](file:///home/ubuntu/projects/zero/apps/mail/config/shortcuts.ts#L82-L125)
- Test: [apps/mail/tests/ctrl-a-shortcut.test.tsx](file:///home/ubuntu/projects/zero/apps/mail/tests/ctrl-a-shortcut.test.tsx)

**Interfaces:**
- Consumes: `Shortcut` type from [shortcuts.ts](file:///home/ubuntu/projects/zero/apps/mail/config/shortcuts.ts).
- Produces: `enhancedKeyboardShortcuts` containing `selectAll` under both `mail-list` and `thread-display`.

- [ ] **Step 1: Write failing test in `apps/mail/tests/ctrl-a-shortcut.test.tsx`**

```tsx
/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { enhancedKeyboardShortcuts } from '../config/shortcuts';

describe('Ctrl + A Shortcut Configuration', () => {
  it('registers selectAll in both mail-list and thread-display scopes', () => {
    const threadDisplaySelectAll = enhancedKeyboardShortcuts.find(
      (s) => s.scope === 'thread-display' && s.action === 'selectAll',
    );
    const mailListSelectAll = enhancedKeyboardShortcuts.find(
      (s) => s.scope === 'mail-list' && s.action === 'selectAll',
    );

    expect(mailListSelectAll).toBeDefined();
    expect(mailListSelectAll?.keys).toEqual(['mod', 'a']);

    expect(threadDisplaySelectAll).toBeDefined();
    expect(threadDisplaySelectAll?.keys).toEqual(['mod', 'a']);
    expect(threadDisplaySelectAll?.preventDefault).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm --filter @zero/mail test tests/ctrl-a-shortcut.test.tsx
```
Expected: FAIL with `threadDisplaySelectAll` being `undefined`.

- [ ] **Step 3: Implement minimal change in `apps/mail/config/shortcuts.ts`**

Add the `selectAll` shortcut to `threadDisplayShortcuts`:
```typescript
const threadDisplayShortcuts: Shortcut[] = [
  {
    keys: ['mod', 'a'],
    action: 'selectAll',
    type: 'combination',
    description: 'Select all emails',
    scope: 'thread-display',
    preventDefault: true,
  },
  {
    keys: ['r'],
    action: 'reply',
    type: 'single',
    description: 'Reply to email',
    scope: 'thread-display',
  },
  ...
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm --filter @zero/mail test tests/ctrl-a-shortcut.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit changes**

```bash
git add apps/mail/config/shortcuts.ts apps/mail/tests/ctrl-a-shortcut.test.tsx
git commit -m "fix(shortcuts): register selectAll under thread-display scope"
```

---

### Task 2: Implement `selectAll` Handler in `ThreadDisplayHotkeys`

**Files:**
- Modify: [apps/mail/lib/hotkeys/thread-display-hotkeys.tsx](file:///home/ubuntu/projects/zero/apps/mail/lib/hotkeys/thread-display-hotkeys.tsx)
- Test: [apps/mail/tests/ctrl-a-shortcut.test.tsx](file:///home/ubuntu/projects/zero/apps/mail/tests/ctrl-a-shortcut.test.tsx)

**Interfaces:**
- Consumes: `useThreads()` from [apps/mail/hooks/use-threads.ts](file:///home/ubuntu/projects/zero/apps/mail/hooks/use-threads.ts), `useMail()` from [apps/mail/components/mail/use-mail.ts](file:///home/ubuntu/projects/zero/apps/mail/components/mail/use-mail.ts).
- Produces: `handlers.selectAll` function in `ThreadDisplayHotkeys`.

- [ ] **Step 1: Add handler test to `apps/mail/tests/ctrl-a-shortcut.test.tsx`**

```tsx
import { renderHook, act } from '@testing-library/react';
// Test that pressing selectAll when an email is open selects all emails or toggles off
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm --filter @zero/mail test tests/ctrl-a-shortcut.test.tsx
```
Expected: FAIL because `ThreadDisplayHotkeys` does not provide a `selectAll` handler.

- [ ] **Step 3: Implement `selectAll` in `apps/mail/lib/hotkeys/thread-display-hotkeys.tsx`**

In [apps/mail/lib/hotkeys/thread-display-hotkeys.tsx](file:///home/ubuntu/projects/zero/apps/mail/lib/hotkeys/thread-display-hotkeys.tsx):
```typescript
import { useMail } from '@/components/mail/use-mail';
import { useThreads } from '@/hooks/use-threads';
import { m } from '@/paraglide/messages';
import { toast } from 'sonner';
import { useCallback } from 'react';

// Inside ThreadDisplayHotkeys:
const [mail, setMail] = useMail();
const [, items] = useThreads();

const selectAll = useCallback(() => {
  if (mail.bulkSelected.length > 0) {
    setMail((prev) => ({
      ...prev,
      bulkSelected: [],
    }));
  } else if (items.length > 0) {
    const allIds = items.map((item) => item.id);
    setMail((prev) => ({
      ...prev,
      bulkSelected: allIds,
    }));
  } else {
    toast.info(m['common.mail.noEmailsToSelect']());
  }
}, [items, mail.bulkSelected.length, setMail]);

// Add to handlers:
const handlers = {
  selectAll,
  closeView: () => closeView(new KeyboardEvent('keydown', { key: 'Escape' })),
  ...
};
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm --filter @zero/mail test tests/ctrl-a-shortcut.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit changes**

```bash
git add apps/mail/lib/hotkeys/thread-display-hotkeys.tsx apps/mail/tests/ctrl-a-shortcut.test.tsx
git commit -m "feat(mail): handle selectAll in thread-display hotkeys"
```

---

### Task 3: Enable `mail-list` Scope During Multi-Selection in `mail.tsx`

**Files:**
- Modify: [apps/mail/components/mail/mail.tsx:406-420](file:///home/ubuntu/projects/zero/apps/mail/components/mail/mail.tsx#L406-L420)
- Test: [apps/mail/tests/ctrl-a-shortcut.test.tsx](file:///home/ubuntu/projects/zero/apps/mail/tests/ctrl-a-shortcut.test.tsx)

**Interfaces:**
- Consumes: `mail.bulkSelected` from `useMail()`, `threadId`, `isWideSplit`, `listCollapsed`.
- Produces: Correct scope activation (`mail-list` active whenever `mail.bulkSelected.length > 0`).

- [ ] **Step 1: Add scope transition test to `apps/mail/tests/ctrl-a-shortcut.test.tsx`**

Test that when `bulkSelected` has items, `mail-list` scope is enabled even if `threadId` is present in the URL.

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm --filter @zero/mail test tests/ctrl-a-shortcut.test.tsx
```
Expected: FAIL because `Boolean(threadId)` disables `mail-list`.

- [ ] **Step 3: Update `apps/mail/components/mail/mail.tsx`**

Update the scope effect in [apps/mail/components/mail/mail.tsx](file:///home/ubuntu/projects/zero/apps/mail/components/mail/mail.tsx):
```typescript
  const isBulkSelectionActive = mail.bulkSelected.length > 0;

  useEffect(() => {
    // When bulk selection is active, mail-list scope must be active for bulk operations (d, r, u, a, esc)
    if (isBulkSelectionActive) {
      enableScope('mail-list');
      disableScope('thread-display');
      return () => {
        disableScope('mail-list');
      };
    }

    const listHidden = Boolean(threadId) || (isWideSplit && listCollapsed);
    if (listHidden) {
      enableScope('thread-display');
      disableScope('mail-list');
    } else {
      enableScope('mail-list');
      disableScope('thread-display');
    }

    return () => {
      disableScope('thread-display');
      disableScope('mail-list');
    };
  }, [threadId, isWideSplit, listCollapsed, isBulkSelectionActive, enableScope, disableScope]);
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm --filter @zero/mail test tests/ctrl-a-shortcut.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Run all mail test suites to ensure no regressions**

Run:
```bash
pnpm --filter @zero/mail test
```
Expected: All existing tests pass.

- [ ] **Step 6: Commit changes**

```bash
git add apps/mail/components/mail/mail.tsx apps/mail/tests/ctrl-a-shortcut.test.tsx
git commit -m "fix(mail): prioritize mail-list scope during bulk selection"
```

---

## Verification & Acceptance Criteria

1. **When no email is open:**
   - Pressing `Ctrl + A` (`mod + a`) selects all emails in the list.
   - Pressing `Ctrl + A` again deselects all emails.
2. **When an email is open on screen:**
   - Pressing `Ctrl + A` selects all emails in the list.
   - In the left pane, all email cards show selected state and the header displays `"{count} selected"` with the `ESC` exit button.
   - Pressing `Ctrl + A` again deselects all emails.
   - Pressing `Escape` or clicking the `ESC` button deselects all emails.
   - Pressing `d` bulk deletes all selected emails.
   - Pressing `r` marks all selected emails as read.
3. **When typing in an input field:**
   - In the search bar or reply composer (TipTap editor), pressing `Ctrl + A` selects the text inside the input/composer; it does NOT trigger email selection.
4. **Automated tests:**
   - `pnpm --filter @zero/mail test tests/ctrl-a-shortcut.test.tsx` passes cleanly.
