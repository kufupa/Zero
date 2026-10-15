---
title: "Ctrl + A Select All and Bulk Actions Inactive When Thread Open in Reading Pane"
date: "2026-09-14"
category: "ui-bugs"
module: "apps/mail / hotkeys & bulk selection"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "medium"
symptoms:
  - "Ctrl + A fails to select all emails when an email thread is open in the reading pane"
  - "Bulk action hotkeys (delete, mark read, escape) inactive during bulk selection if threadId is present in URL"
root_cause: "scope_issue"
resolution_type: "code_fix"
related_components:
  - "email_processing"
tags:
  - "keyboard-shortcuts"
  - "hotkeys"
  - "mail-list"
  - "thread-display"
  - "bulk-selection"
  - "select-all"
---

# Ctrl + A Select All and Bulk Actions Inactive When Thread Open in Reading Pane

## Problem

When viewing an email thread in the split-view reading pane, pressing `Ctrl + A` (`Cmd + A` on macOS) failed to select all emails in the current folder, instead causing the browser to fall back to native window text selection. Furthermore, multi-selecting threads while an email was open left all bulk operation shortcuts (`d` for bulk delete, `r` for mark read, `u` for mark unread, `e` for archive, and `Escape` to cancel) unresponsive because the application remained locked in the `thread-display` hotkey scope.

## Symptoms

- **Browser text selection leak:** Pressing `Ctrl + A` (or `Cmd + A`) while an email thread was open highlighted raw text and UI chrome across the DOM instead of selecting all email threads in the active folder.
- **Dead bulk action shortcuts:** When a user selected multiple emails using mouse clicks (`Ctrl + Click` or checkbox selection) while a thread was displayed, pressing bulk action keys such as `d` (bulk delete), `r` (mark read), or `Escape` failed to trigger bulk actions.
- **Conflicting shortcut behaviors:** Pressing `r` while emails were selected in split view either triggered the single-thread reply action on the open thread instead of marking selected threads as read, or was ignored altogether.
- **Manual click dependency:** Users were forced to deselect emails manually using mouse clicks on toolbar buttons rather than using standard keyboard workflows (`Escape`, `Ctrl + A` toggle).

## What Didn't Work

- **Restricting shortcuts to mouse-hovered panels:** An initial hypothesis proposed enabling `mail-list` hotkeys only when the user's cursor hovered over or clicked into the list panel (`handleMailListMouseEnter` / `handleMailListMouseLeave`). This was rejected because keyboard-driven power users do not move the mouse to re-focus panels before executing global selection shortcuts like `Ctrl + A`.
- **Disabling Ctrl+A when reading an email:** Another consideration was whether reading-pane conventions (e.g. in Outlook or Gmail desktop) should suppress inbox-level `Ctrl + A` while an email is open. User research and industry standard testing confirmed that outside of an active text input or compose area, `Ctrl + A` universally selects all collection items in the current folder.
- **Relying on single-scope definition with bubbling:** Attempting to define `selectAll` exclusively under `mail-list` and relying on hotkey bubbling failed because `react-hotkeys-hook` evaluates scopes as mutually exclusive sets; when `mail-list` scope was disabled upon navigating to a thread, events never propagated to the list's handler.
- **Inline scope switching logic inside components:** Embedding inline boolean checks directly inside the `mail.tsx` `useEffect` hook without extracting a pure state resolver made it error-prone to handle multiple conditions (collapsed panels, responsive single-pane mode, active thread navigation, and bulk selection states).

## Solution

The solution introduces bidirectional shortcut registration for `selectAll`, wires the selection handler to both scopes, and establishes a pure scope resolver that prioritizes `mail-list` scope whenever bulk selection is active.

### 1. Registering `selectAll` under `thread-display` Scope
In `apps/mail/config/shortcuts.ts`, `selectAll` (`mod + a`) was added to `threadDisplayShortcuts` with `preventDefault: true` so the browser's native text selection is intercepted when viewing an open thread:

```typescript
// apps/mail/config/shortcuts.ts
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
  // ...
];
```

### 2. Adding `selectAll` Handler in `ThreadDisplayHotkeys`
In `apps/mail/lib/hotkeys/thread-display-hotkeys.tsx`, `ThreadDisplayHotkeys` now consumes `useMail` and `useThreads` to toggle selection of all loaded threads, mirroring the behavior of `MailListHotkeys`:

```typescript
// apps/mail/lib/hotkeys/thread-display-hotkeys.tsx
export function ThreadDisplayHotkeys() {
  const scope = 'thread-display';
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

  const handlers = {
    selectAll,
    closeView: () => closeView(new KeyboardEvent('keydown', { key: 'Escape' })),
    // ...
  };

  const threadDisplayShortcuts = enhancedKeyboardShortcuts.filter(
    (shortcut) => shortcut.scope === scope,
  );

  useShortcuts(threadDisplayShortcuts, handlers, { scope });

  return null;
}
```

### 3. Prioritizing Bulk Selection in `resolveActiveMailScope`
In `apps/mail/lib/mail/mail-panel-visibility.ts`, a pure function `resolveActiveMailScope` was implemented. It guarantees that whenever `hasBulkSelection` is true, the active hotkey scope is forced to `mail-list`, regardless of whether a thread is open or whether the list is collapsed:

```typescript
// apps/mail/lib/mail/mail-panel-visibility.ts
export type MailActiveScope = 'mail-list' | 'thread-display';

export function resolveActiveMailScope(args: {
  hasBulkSelection: boolean;
  threadId: string | null;
  isWideSplit: boolean;
  listCollapsed: boolean;
}): MailActiveScope {
  if (args.hasBulkSelection) {
    return 'mail-list';
  }
  const listHidden = Boolean(args.threadId) || (args.isWideSplit && args.listCollapsed);
  return listHidden ? 'thread-display' : 'mail-list';
}
```

### 4. Binding Active Scope in `mail.tsx`
In `apps/mail/components/mail/mail.tsx`, the layout component computes `activeScope` using `resolveActiveMailScope` and activates the corresponding hotkey scope via `enableScope` and `disableScope`:

```typescript
// apps/mail/components/mail/mail.tsx
export function MailLayout() {
  // ...
  const activeScope = resolveActiveMailScope({
    hasBulkSelection: mail.bulkSelected.length > 0,
    threadId,
    isWideSplit,
    listCollapsed,
  });

  useEffect(() => {
    if (activeScope === 'mail-list') {
      enableScope('mail-list');
      disableScope('thread-display');
    } else {
      enableScope('thread-display');
      disableScope('mail-list');
    }

    return () => {
      disableScope('thread-display');
      disableScope('mail-list');
    };
  }, [activeScope, enableScope, disableScope]);
  // ...
}
```

### 5. Contract Unit Tests
In `apps/mail/tests/ctrl-a-shortcut.test.tsx`, automated tests verify that `selectAll` is registered across both scopes, that the handler correctly selects and clears thread IDs, and that `resolveActiveMailScope` gives precedence to bulk selection:

```typescript
// apps/mail/tests/ctrl-a-shortcut.test.tsx
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

  it('ThreadDisplayHotkeys provides selectAll handler that selects all loaded threads', () => {
    render(<ThreadDisplayHotkeys />);
    expect(mocks.capturedHandlers.selectAll).toBeDefined();

    mocks.capturedHandlers.selectAll();
    expect(mocks.setMail).toHaveBeenCalled();
    const updateFn = mocks.setMail.mock.calls[0][0];
    const nextState = updateFn({ bulkSelected: [] });
    expect(nextState.bulkSelected).toEqual(['thread-1', 'thread-2']);
  });

  describe('resolveActiveMailScope', () => {
    it('prioritizes mail-list scope when bulk selection is active even with open thread', async () => {
      const { resolveActiveMailScope } = await import('../lib/mail/mail-panel-visibility');
      expect(
        resolveActiveMailScope({
          hasBulkSelection: true,
          threadId: 'thread-123',
          isWideSplit: true,
          listCollapsed: false,
        }),
      ).toBe('mail-list');
    });
  });
});
```

## Why This Works

Split-view email clients maintain dual contexts simultaneously: a master list pane and a detailed item reading pane. In such architectures, keyboard shortcuts frequently suffer from semantic collisions:
- In `thread-display` scope: `r` means *Reply*, `a` means *Reply All*, and `d` navigates or deletes the current open message.
- In `mail-list` scope: `r` means *Mark as Read*, `a` (via `mod + a`) means *Select All*, and `d` performs *Bulk Delete*.

When an email is opened, `threadId` is populated in the URL, which legitimately shifts navigation and single-item reading shortcuts into `thread-display` scope. However:
1. **Bidirectional Entry:** By defining `selectAll` in both scopes, the initial keystroke (`Ctrl + A`) is captured regardless of whether the user was actively reading an email or browsing the list. The handler populates `mail.bulkSelected` with the loaded thread IDs.
2. **State-Driven Precedence Transition:** Once `mail.bulkSelected.length > 0`, the user has entered "selection mode". At this point, folder-level bulk actions take precedence over single-thread actions. `resolveActiveMailScope` evaluates `hasBulkSelection` first, immediately deactivating `thread-display` and activating `mail-list`.
3. **Clean Teardown:** Once bulk actions finish or the user hits `Escape` (which clears `mail.bulkSelected`), `hasBulkSelection` becomes `false`. `resolveActiveMailScope` automatically transitions back to `thread-display` scope since `threadId` is still present, restoring single-thread shortcuts without extra navigation logic.
4. **Input Safety:** Hotkeys configured through `react-hotkeys-hook` have `enableOnFormTags: false` and `enableOnContentEditable: false` by default, guaranteeing that pressing `Ctrl + A` inside an email composer (TipTap editor) or search field selects text within the input rather than triggering list selection.

## Prevention

To prevent similar hotkey scope collisions and broken shortcuts across multi-pane applications, adhere to the following architecture rules:

1. **Bidirectional Registration for Global Collection Shortcuts:**
   Universal actions that operate on the collection level (such as `Select All`, `Search`, or `Refresh`) must be registered in all active pane scopes. Never assume a global action will only be triggered when its corresponding visual pane has exclusive focus.

2. **Selection State Override Hierarchy (Selection Priority Rule):**
   Multi-pane applications must treat multi-selection as an overarching mode that supersedes view-specific navigation scopes. Always enforce an explicit priority order in hotkey resolution:
   $$\text{Selection Mode} \succ \text{Detail / Reading Pane} \succ \text{Master List}$$

3. **Pure Function Scope Resolution:**
   Isolate scope calculation into a pure, deterministic function (e.g. `resolveActiveMailScope`) that accepts plain state values (`hasBulkSelection`, `threadId`, `isWideSplit`, `listCollapsed`). Do not distribute scope decision logic across scattered UI components or lifecycle effects.

4. **Contract Testing for Hotkey Scope Parity:**
   When defining keyboard shortcuts that span multiple panels:
   - Verify shortcut definitions exist in `enhancedKeyboardShortcuts` across all intended scopes.
   - Test handler callbacks in isolation using mock states.
   - Write automated unit tests for the pure scope resolver covering all permutations: list-only, detail-open, detail-open with multi-selection, collapsed list panes, and empty states.

## Related Issues

- [mail-close-empty-pane-mid-width.md](docs/solutions/ui-bugs/mail-close-empty-pane-mid-width.md): Extended `apps/mail/lib/mail/mail-panel-visibility.ts` created in this fix to include `resolveActiveMailScope`.
- [mail-reply-actions-in-message-and-thread-toolbar.md](docs/solutions/ui-bugs/mail-reply-actions-in-message-and-thread-toolbar.md): Shared `ThreadDisplayHotkeys` component surface.
- [dnd-kit-mail-file-drag-dragend-threadids-race.md](docs/solutions/logic-errors/dnd-kit-mail-file-drag-dragend-threadids-race.md): Shared `mail.bulkSelected` multi-thread state management.
