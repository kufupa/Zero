# Email Drag-and-Drop Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix email drag-and-drop mechanics by centering the drag overlay badge under the cursor, eliminating unintended folder filing on empty space caused by `closestCenter`, providing honest notification microcopy (`Moved to {folderName}` instead of `Archived`), guarding mobile touch scroll, and documenting the client request for attaching emails onto drafts.

**Architecture:**
- Anchor the `@dnd-kit` `<DragOverlay>` preview badge directly to the cursor coordinates using `@dnd-kit/modifiers`'s `snapCenterToCursor`, avoiding the offset caused by wide table row bounding boxes. Add `pointer-events-none select-none` to the overlay pill so it does not intercept pointer events or cause cursor flicker.
- Relocate and restrict `mailFileCollisionDetection` in `apps/mail/lib/mail/file-drag.ts` to direct pointer containment (`pointerWithin`), re-exporting it in `MailFileDragProvider`. Removing the unconstrained `closestCenter` fallback guarantees that releasing an email over empty space, email list rows, or AI categories cancels cleanly without filing into an arbitrary folder.
- In `apps/mail/lib/mail/file-drag.ts`, provide `formatFileSuccessMessage(folderName)` with 24-character truncation so Sonner toasts never clip the `Undo` button.
- In `use-optimistic-actions.ts`, look up the target label name from `userLabels` within `optimisticFileThreads` so the toast reads `Moved to {folderName}` (with the existing Undo button), giving users clear feedback on where their message was placed.
- In `apps/mail/components/mail/mail-list.tsx`, disable row drag on mobile devices (`disabled: !idToUse || isMobile`) to prevent drag listeners from hijacking touch-scroll gestures.

**Tech Stack:** Next.js / React Router (`apps/mail`), `@dnd-kit/core`, `@dnd-kit/modifiers` (v9.0.0), Vitest.

## Global Constraints

- **Single-hotel pilot safety:** Never run project-wide format/lint (`pnpm check`, `pnpm lint`, `pnpm format`).
- **No mutations to live pilot database:** Vitest runs against isolated/unit mocks only; never run Vitest against pilot RDS.
- **Preserve existing filing contract:** `mail.fileThreads` tRPC mutation and existing `activeDragRef` timing-race protections must remain intact.
- **Pure Node unit tests:** Test files under `apps/mail/tests` run in Vitest `node` environment. Keep pure logic functions in `apps/mail/lib/mail/file-drag.ts` decoupled from React components and hooks.
- **Relative file paths only:** All references in tests and implementations use repo-relative paths.

---

### Task 1: Strict Pointer Collision Detection and Overlay Centering

**Files:**
- Modify: `apps/mail/lib/mail/file-drag.ts`
- Modify: `apps/mail/components/mail/mail-file-drag-provider.tsx`
- Test: `apps/mail/tests/file-drag.test.ts`

**Interfaces:**
- `mailFileCollisionDetection: CollisionDetection` (pure helper in `file-drag.ts` using `pointerWithin`)
- `<DragOverlay modifiers={[snapCenterToCursor]}>` with `pointer-events-none select-none` child pill

- [ ] **Step 1: Write the failing behavioral test**

In `apps/mail/tests/file-drag.test.ts`, add behavioral tests verifying that `mailFileCollisionDetection` only returns hits when pointer coordinates are directly inside a droppable rect, and returns `[]` when outside:

```typescript
import { mailFileCollisionDetection } from '@/lib/mail/file-drag';

describe('mailFileCollisionDetection', () => {
  const containerId = '550e8400-e29b-41d4-a716-446655440000';
  const droppableContainers = [
    {
      id: containerId,
      key: containerId,
      data: { current: undefined },
      disabled: false,
      node: { current: null },
      rect: { current: null },
    },
  ];

  const droppableRects = new Map([
    [
      containerId,
      {
        top: 100,
        left: 100,
        bottom: 200,
        right: 200,
        width: 100,
        height: 100,
      },
    ],
  ]);

  it('returns container collision when pointer is inside container bounds', () => {
    const args: any = {
      active: { id: 'thread-1' },
      collisionRect: { top: 0, left: 0, bottom: 20, right: 100, width: 100, height: 20 },
      droppableContainers,
      droppableRects,
      pointerCoordinates: { x: 150, y: 150 }, // Inside rect
    };

    const collisions = mailFileCollisionDetection(args);
    expect(collisions.length).toBeGreaterThan(0);
    expect(collisions[0]?.id).toBe(containerId);
  });

  it('returns empty array when pointer is outside container bounds (no distant closestCenter fallback)', () => {
    const args: any = {
      active: { id: 'thread-1' },
      collisionRect: { top: 0, left: 0, bottom: 20, right: 100, width: 100, height: 20 },
      droppableContainers,
      droppableRects,
      pointerCoordinates: { x: 500, y: 500 }, // Far outside rect (e.g. empty list space)
    };

    const collisions = mailFileCollisionDetection(args);
    expect(collisions).toEqual([]);
  });

  it('returns empty array when pointerCoordinates is null', () => {
    const args: any = {
      active: { id: 'thread-1' },
      collisionRect: { top: 0, left: 0, bottom: 20, right: 100, width: 100, height: 20 },
      droppableContainers,
      droppableRects,
      pointerCoordinates: null,
    };

    expect(mailFileCollisionDetection(args)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter=@zero/mail exec vitest run tests/file-drag.test.ts`
Expected: FAIL (`mailFileCollisionDetection` is not yet exported from `file-drag.ts`).

- [ ] **Step 3: Implement minimal code changes**

1. In `apps/mail/lib/mail/file-drag.ts`:
Import `pointerWithin` and `type CollisionDetection` from `@dnd-kit/core`.
Add pure export:
```typescript
/**
 * Pointer hit only: drop only registers when pointer is directly within a folder.
 * Omits closestCenter fallback to prevent drops on empty space from filing into nearest folder.
 */
export const mailFileCollisionDetection: CollisionDetection = (args) => {
  return pointerWithin(args);
};
```

2. In `apps/mail/components/mail/mail-file-drag-provider.tsx`:
- Remove `closestCenter` and `pointerWithin` imports from `@dnd-kit/core`.
- Import `mailFileCollisionDetection` from `@/lib/mail/file-drag` and re-export.
- Import `snapCenterToCursor` from `@dnd-kit/modifiers`.
- Add `modifiers={[snapCenterToCursor]}` to `<DragOverlay>`.
- Add `pointer-events-none select-none opacity-95 shadow-lg` to the drag pill div.

```tsx
// apps/mail/components/mail/mail-file-drag-provider.tsx
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { snapCenterToCursor } from '@dnd-kit/modifiers';
import {
  fileDragOverlayLabel,
  mailFileCollisionDetection,
  resolveFileDragThreadIds,
  shouldFileOnDragEnd,
  type FileDragData,
} from '@/lib/mail/file-drag';

export { mailFileCollisionDetection };
```

And in JSX:
```tsx
<DragOverlay modifiers={[snapCenterToCursor]} dropAnimation={null}>
  {activeDrag ? (
    <div className="dark:bg-panelDark pointer-events-none max-w-[240px] select-none truncate rounded-md border border-[#E7E7E7] bg-white px-3 py-2 text-sm text-black opacity-95 shadow-lg dark:border-[#252525] dark:text-white/90">
      {fileDragOverlayLabel(activeDrag.threadIds, activeDrag.subject)}
    </div>
  ) : null}
</DragOverlay>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter=@zero/mail exec vitest run tests/file-drag.test.ts`
Expected: PASS with 14 passing tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/mail/file-drag.ts apps/mail/components/mail/mail-file-drag-provider.tsx apps/mail/tests/file-drag.test.ts
git commit -m "fix(mail): snap drag overlay to cursor and restrict drop collision to pointer-within"
```

---

### Task 2: Honest Notification Microcopy ("Moved to {folderName}") & Mobile Scroll Guard

**Files:**
- Modify: `apps/mail/lib/mail/file-drag.ts`
- Modify: `apps/mail/hooks/use-optimistic-actions.ts:480-568`
- Modify: `apps/mail/components/mail/mail-list.tsx:166-174`
- Test: `apps/mail/tests/file-drag.test.ts`

**Interfaces:**
- `formatFileSuccessMessage(folderName?: string | null): string`
- `useDraggable({ disabled: !idToUse || isMobile })` in `mail-list.tsx`

- [x] **Step 1: Write the failing test**

In `apps/mail/tests/file-drag.test.ts`, add unit tests for `formatFileSuccessMessage`:

```typescript
import { formatFileSuccessMessage } from '@/lib/mail/file-drag';

describe('formatFileSuccessMessage', () => {
  it('formats specific folder name when provided', () => {
    expect(formatFileSuccessMessage('Bookings')).toBe('Moved to Bookings');
    expect(formatFileSuccessMessage('Inquiries')).toBe('Moved to Inquiries');
  });

  it('truncates long folder names to 24 chars to avoid clipping toast undo button', () => {
    expect(formatFileSuccessMessage('Super Extremely Long Hotel Folder Name')).toBe('Moved to Super Extremely Long H...');
  });

  it('falls back gracefully when folder name is missing or whitespace', () => {
    expect(formatFileSuccessMessage(null)).toBe('Moved to folder');
    expect(formatFileSuccessMessage(undefined)).toBe('Moved to folder');
    expect(formatFileSuccessMessage('   ')).toBe('Moved to folder');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter=@zero/mail exec vitest run tests/file-drag.test.ts`
Expected: FAIL (`formatFileSuccessMessage` is not defined).

- [x] **Step 3: Implement minimal code changes**

1. In `apps/mail/lib/mail/file-drag.ts`:
```typescript
const MAX_TOAST_FOLDER_LENGTH = 24;

export function formatFileSuccessMessage(folderName?: string | null): string {
  const cleanName = folderName?.trim();
  if (!cleanName) {
    return 'Moved to folder';
  }
  if (cleanName.length > MAX_TOAST_FOLDER_LENGTH) {
    return `Moved to ${cleanName.slice(0, MAX_TOAST_FOLDER_LENGTH)}...`;
  }
  return `Moved to ${cleanName}`;
}
```

2. In `apps/mail/hooks/use-optimistic-actions.ts`:
Import `formatFileSuccessMessage` from `@/lib/mail/file-drag`.
In `optimisticFileThreads(threadIds: string[], currentFolder: string, labelId: string)`:
```typescript
    const targetLabel = userLabels?.find((l) => l.id === labelId);
    const successToastMessage = formatFileSuccessMessage(targetLabel?.name);

    createPendingAction({
      type: 'MOVE',
      threadIds,
      params: { currentFolder, destination: 'archive' },
      optimisticId: moveOptimisticId,
      execute: async () => { ... },
      undo: () => { ... },
      toastMessage: successToastMessage,
      folders: [currentFolder, 'archive'],
    });
```

3. In `apps/mail/components/mail/mail-list.tsx`:
Add `isMobile` check from `useSidebar()` to the `useDraggable` configuration:
```typescript
    const { isMobile } = useSidebar();
    const {
      attributes: dragAttributes,
      listeners: dragListeners,
      setNodeRef: setDragNodeRef,
      isDragging,
    } = useDraggable({
      id: idToUse ?? message.id,
      disabled: !idToUse || isMobile,
      data: {
        type: 'mail-thread',
        threadId: idToUse ?? message.id,
        subject: latestMessage?.subject ?? null,
      } satisfies FileDragData,
    });
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter=@zero/mail exec vitest run tests/file-drag.test.ts`
Expected: PASS.

Run regression test suite:
Run: `pnpm --filter=@zero/mail exec vitest run tests/thread-actions-contract.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/mail/lib/mail/file-drag.ts apps/mail/hooks/use-optimistic-actions.ts apps/mail/components/mail/mail-list.tsx apps/mail/tests/file-drag.test.ts
git commit -m "fix(mail): display folder name in move toast and disable row dragging on mobile"
```

---

### Task 3: Client Request Advisory Documentation ("Attach on Info or other email")

**Files:**
- Create: `docs/solutions/architecture-patterns/mail-drag-to-attach-advisory.md`

**Context & Findings:**
- **Client Inquiry:** *"The emails are not moving ( dragging ) so I can attach on Info or onto other email ( please advise )"*.
- **Scans Email Verification:** Live database on EC2 verified that `Scans` (`thread_id: d38f88b3-6564-4ea1-b4de-4b6911af17fb`) is safe, unarchived (`is_archived: false`), and in the Inbox.
- **Client Feature Scope:**
  - In Outlook, dragging an email onto an open compose/reply tab attaches it as an `.eml` attachment.
  - Zero currently implements `@dnd-kit` drag strictly for list-to-folder filing (`mail.fileThreads`).
  - The composer drop zone only accepts OS files (`event.dataTransfer.files`).
  - Document this distinction in an advisory document for the product roadmap so FO client expectations are managed accurately.

- [ ] **Step 1: Write advisory document**

Record technical advisory in `docs/solutions/architecture-patterns/mail-drag-to-attach-advisory.md` detailing:
1. Current architecture: `@dnd-kit` internal list → My folders filing.
2. Reason why dragging onto composer does not attach: Composer uses HTML5 native file drop (`DataTransfer.files`), while mail list rows use `@dnd-kit` PointerSensor without HTML5 `.eml` drag data payload.
3. Path to support Outlook-style drag-to-attach in a future release:
   - Provide HTML5 `onDragStart` with `application/vnd.zero.thread+json` or `message/rfc822`.
   - Update composer drop target to accept internal thread drag payload and fetch raw MIME or attach thread reference.

- [ ] **Step 2: Commit**

```bash
git add docs/solutions/architecture-patterns/mail-drag-to-attach-advisory.md
git commit -m "docs(architecture): record drag-to-attach client requirements advisory"
```

---

## Verification Plan

### Automated Tests
```bash
# 1. Verify file drag logic and collision detection
pnpm --filter=@zero/mail exec vitest run tests/file-drag.test.ts

# 2. Verify thread actions contract
pnpm --filter=@zero/mail exec vitest run tests/thread-actions-contract.test.ts
```

### Manual Verification
1. **Cursor Centering:** Grab any email thread in `/mail/inbox`. Notice the drag preview pill immediately centers right under the cursor point.
2. **Safe Drop Outside Folders:** Drag the email and release it over the email list, blank space, or reading pane. Verify the drag cleanly cancels without removing the email or displaying a toast.
3. **Targeted Drop into Folder:** Drag the email over a folder in "My folders" (e.g. `Bookings`).
   - Notice the folder highlights with `bg-sidebar-accent`.
   - Release the mouse.
   - Verify toast displays: `Moved to Bookings` with the `Undo` button.
   - Click `Undo` within 5 seconds to verify restore works seamlessly.
4. **"Scans" Email Confirmation:** Load `/mail/inbox` and verify the `Scans` email is visible and accessible.

---

## GSTACK REVIEW REPORT

| Review Gate | Runs | Last Run | Status | Findings / Disposition |
|---|---|---|---|---|
| **Engineering Review** (`gstack-plan-eng-review`) | 1 | 2026-09-04 15:12 UTC | **PASSED** (9.2/10) | Verified `activeDragRef` timing-race guard preserved; moved pure collision detection to `file-drag.ts` to keep node tests decoupled from React component tree; added behavioral collision tests. |
| **Simplicity Review** (`ponytail-review`) | 1 | 2026-09-04 15:09 UTC | **PASSED** | Stripped speculative abstractions; kept pure helpers minimal and direct; decoupled client advisory doc from core code logic. |
| **Design Review** (`gstack-plan-design-review`) | 1 | 2026-09-04 15:10 UTC | **PASSED** | Added `pointer-events-none select-none` to drag overlay pill to eliminate hover flicker; capped toast folder name to 24 chars to avoid clipping Undo button; added `isMobile` drag guard for touch scrolling. |

VERDICT: APPROVED FOR IMPLEMENTATION

NO UNRESOLVED DECISIONS
