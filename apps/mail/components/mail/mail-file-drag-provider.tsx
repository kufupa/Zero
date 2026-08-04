'use client';

import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useOptimisticActions } from '@/hooks/use-optimistic-actions';
import { useActiveConnection } from '@/hooks/use-connections';
import { useMail } from '@/components/mail/use-mail';
import {
  fileDragOverlayLabel,
  resolveFileDragThreadIds,
  shouldFileOnDragEnd,
  type FileDragData,
} from '@/lib/mail/file-drag';
import { useParams } from 'react-router';
import { useCallback, useRef, useState, type ReactNode } from 'react';

type ActiveFileDrag = {
  threadIds: string[];
  subject?: string | null;
};

/** Prefer pointer hit; fall back to closest center near folder edge. */
export const mailFileCollisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  if (pointerHits.length > 0) return pointerHits;
  return closestCenter(args);
};

/**
 * One live DndContext for list → My folders filing.
 * Nested note-panel DndContext stays isolated for note reorder.
 *
 * Drag payload lives in a ref as well as state: PointerSensor can fire
 * dragEnd before React re-renders dragStart state, which would drop an
 * empty threadIds list and skip filing.
 */
export function MailFileDragProvider({ children }: { children: ReactNode }) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
  );
  const { data: activeConnection } = useActiveConnection();
  const { optimisticFileThreads } = useOptimisticActions();
  const [mail] = useMail();
  const params = useParams<{ folder: string }>();
  const folder = params?.folder ?? 'inbox';

  const dragStartTransportIdRef = useRef<string | null>(null);
  const activeDragRef = useRef<ActiveFileDrag | null>(null);
  const [activeDrag, setActiveDrag] = useState<ActiveFileDrag | null>(null);

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

  const clearDrag = useCallback(() => {
    activeDragRef.current = null;
    setActiveDrag(null);
    dragStartTransportIdRef.current = null;
  }, []);

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

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={mailFileCollisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={clearDrag}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {activeDrag ? (
          <div className="dark:bg-panelDark max-w-[240px] truncate rounded-md border border-[#E7E7E7] bg-white px-3 py-2 text-sm text-black shadow-md dark:border-[#252525] dark:text-white/90">
            {fileDragOverlayLabel(activeDrag.threadIds, activeDrag.subject)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
