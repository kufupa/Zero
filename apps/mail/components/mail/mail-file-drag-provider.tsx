'use client';

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useOptimisticActions } from '@/hooks/use-optimistic-actions';
import { useActiveConnection } from '@/hooks/use-connections';
import { useMail } from '@/components/mail/use-mail';
import {
  fileDragOverlayLabel,
  isUserFolderDroppableId,
  resolveFileDragThreadIds,
  type FileDragData,
} from '@/lib/mail/file-drag';
import { useParams } from 'react-router';
import { useCallback, useRef, useState, type ReactNode } from 'react';

type ActiveFileDrag = {
  threadIds: string[];
  subject?: string | null;
};

/**
 * One live DndContext for list → My folders filing.
 * Nested note-panel DndContext stays isolated for note reorder.
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
  const [activeDrag, setActiveDrag] = useState<ActiveFileDrag | null>(null);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      dragStartTransportIdRef.current = activeConnection?.id ?? null;
      const draggedId = String(event.active.id);
      const data = event.active.data.current as FileDragData | undefined;
      const threadIds = resolveFileDragThreadIds(draggedId, mail.bulkSelected);
      setActiveDrag({
        threadIds,
        subject: data?.subject ?? null,
      });
    },
    [activeConnection?.id, mail.bulkSelected],
  );

  const clearDrag = useCallback(() => {
    setActiveDrag(null);
    dragStartTransportIdRef.current = null;
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const overId = event.over?.id != null ? String(event.over.id) : null;
      const threadIds = activeDrag?.threadIds ?? [];
      const startTransportId = dragStartTransportIdRef.current;
      const currentTransportId = activeConnection?.id ?? null;

      clearDrag();

      // Mailbox / transport switch mid-drag → cancel
      if (startTransportId !== currentTransportId) {
        return;
      }

      if (!overId || !isUserFolderDroppableId(overId) || threadIds.length === 0) {
        return;
      }

      optimisticFileThreads(threadIds, folder, overId);
    },
    [activeConnection?.id, activeDrag?.threadIds, clearDrag, folder, optimisticFileThreads],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
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
