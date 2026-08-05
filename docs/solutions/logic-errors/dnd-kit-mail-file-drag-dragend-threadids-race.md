---
title: dnd-kit My folders file-drag dragEnd empties threadIds before React state
date: 2026-08-04
category: logic-errors
module: apps/mail MailFileDragProvider + My folders filing
problem_type: logic_error
component: email_processing
severity: high
symptoms:
  - "Dragging mail onto a My folders target looked interactive but mail.fileThreads never ran (silent no-op)"
  - "onDragEnd resolved threadIds as [] even though onDragStart had computed a payload"
  - "Fast pointer / headless Playwright drags reproduced the miss; slow human drags sometimes hid it"
root_cause: async_timing
resolution_type: code_fix
tags:
  - dnd-kit
  - my-folders
  - mail-file-drag
  - active-drag-ref
  - pointer-sensor
  - file-threads
  - async-timing
  - ec2-pilot
related_components:
  - testing_framework
---

# dnd-kit My folders file-drag dragEnd empties threadIds before React state

## Problem

Dragging a thread from the mail list onto a **My folders** label looked interactive but never filed. `MailFileDragProvider` stored the drag payload in React `useState` during `onDragStart` and read that state in `onDragEnd` to call `optimisticFileThreads`. With `@dnd-kit` `PointerSensor`, end can run before React commits the start update, so `threadIds` was `[]` and filing silently no-oped.

## Symptoms

- Pointer drag onto a real user folder completed visually but the thread stayed in the current list.
- No `mail.fileThreads` / optimistic file for that gesture.
- Easier to miss with slow manual drags (re-render sometimes won the race); headless Playwright pointer drags exposed it.
- After the ref fix, the same EC2 smoke saw `fileThreads` `updated:1`, then Move to Inbox restore.

## What Didn't Work

- Tuning drop collision (`pointerWithin` / `closestCenter`) when `event.over` was already a valid label id — hit-testing was not the silent no-op root cause.
- Assuming Move to Inbox / UUID archive-like chrome bugs explained the miss — those are separate product gates ([My folders filing pattern](../architecture-patterns/my-folders-label-archive-filing.md)).
- Keeping `threadIds` sourced only from `useState` in `handleDragEnd` — React state updates are async relative to the sensor’s start→end sequence.

## Solution

Write the drag payload into a ref synchronously in `handleDragStart`; read the ref in `handleDragEnd`. Keep `useState` for `DragOverlay` UI only.

```65:78:apps/mail/components/mail/mail-file-drag-provider.tsx
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      dragStartTransportIdRef.current = activeConnection?.id ?? null;
      const draggedId = String(event.active.id);
      const data = event.active.data.current as FileDragData | undefined;
      const next: ActiveFileDrag = {
        threadIds: resolveFileDragThreadIds(draggedId, mail.bulkSelected),
        subject: data?.subject ?? null,
      };
      activeDragRef.current = next;
      setActiveDrag(next);
    },
    [activeConnection?.id, mail.bulkSelected],
  );
```

```86:109:apps/mail/components/mail/mail-file-drag-provider.tsx
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const overId = event.over?.id != null ? String(event.over.id) : null;
      const threadIds = activeDragRef.current?.threadIds ?? [];
      const startTransportId = dragStartTransportIdRef.current;
      const currentTransportId = activeConnection?.id ?? null;

      clearDrag();

      if (
        !shouldFileOnDragEnd({
          overId,
          threadIds,
          startTransportId,
          currentTransportId,
        })
      ) {
        return;
      }

      optimisticFileThreads(threadIds, folder, overId!);
    },
    [activeConnection?.id, clearDrag, folder, optimisticFileThreads],
  );
```

Pure gate `shouldFileOnDragEnd` still requires same transport, non-`group-*` over id, and `threadIds.length > 0` (see `shouldFileOnDragEnd` in `apps/mail/lib/mail/file-drag.ts`). Tests cover the empty-`threadIds` skip as the race case (`apps/mail/tests/file-drag.test.ts`).

## Why This Works

Refs update synchronously. When `PointerSensor` fires start then end before React flushes `setActiveDrag`, `activeDragRef.current` already holds the payload, so end files real thread ids. Overlay state can lag a frame without blocking the mutation path. Documented in the provider comment block in `apps/mail/components/mail/mail-file-drag-provider.tsx`.

## Prevention

- For dnd-kit (or similar) start/end in one sensor turn: authoritative payload in a ref or `active.data`, not React state alone; state only for overlays.
- Keep pure gates like `shouldFileOnDragEnd` and unit-test empty `threadIds` so the race stays visible in CI.
- Prefer headless pointer-drag smoke for file-to-folder; slow manual drags can hide the race.
- Separate hit-testing bugs from empty-payload bugs: fix collision when drops miss; fix ref-vs-state when targets hit but mutations never run.

## Related Issues

- [My folders filing via mailLabel plus archive](../architecture-patterns/my-folders-label-archive-filing.md) — product/IA pattern; brief drag-end note points here for the dedicated race writeup.
- [Hotel folder UI parity](../ui-bugs/hotel-folder-ui-parity.md) — AI **Folders** vs user **My folders** chrome must stay distinct.
- [Folder-first spam_at matrix](../architecture-patterns/folder-first-spam-at-folder-matrix.md) — `fileThreads` archive / spam placement contract.
- [Compose close draft honesty](./compose-close-draft-honesty.md) — analogous React async timing class in a different surface.
