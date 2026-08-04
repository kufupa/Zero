/**
 * Pure helpers for mail-list → My folders drag-to-file.
 * Droppables are real user label ids only (never synthetic `group-*` rows).
 */

export function resolveFileDragThreadIds(
  draggedId: string,
  selectedIds: readonly string[],
): string[] {
  if (selectedIds.includes(draggedId)) {
    return [...selectedIds];
  }
  return [draggedId];
}

export function isUserFolderDroppableId(id: string | null | undefined): boolean {
  if (!id) return false;
  return !id.startsWith('group-');
}

/** Pure gate for drag-end → file (keeps transport + droppable checks testable). */
export function shouldFileOnDragEnd(opts: {
  overId: string | null;
  threadIds: readonly string[];
  startTransportId: string | null;
  currentTransportId: string | null;
}): boolean {
  if (opts.startTransportId !== opts.currentTransportId) return false;
  if (!opts.overId || !isUserFolderDroppableId(opts.overId)) return false;
  return opts.threadIds.length > 0;
}

export function fileDragOverlayLabel(
  threadIds: readonly string[],
  subject?: string | null,
): string {
  if (threadIds.length > 1) {
    return `${threadIds.length} threads`;
  }
  const trimmed = subject?.trim();
  return trimmed || '1 thread';
}

export type FileDragData = {
  type: 'mail-thread';
  threadId: string;
  subject?: string | null;
};
