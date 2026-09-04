import { pointerWithin, type CollisionDetection } from '@dnd-kit/core';

/**
 * Pure helpers for mail-list → My folders drag-to-file.
 * Droppables are real user label ids only (never synthetic `group-*` rows).
 */

/**
 * Pointer hit only: drop only registers when pointer is directly within a folder.
 * Omits closestCenter fallback to prevent drops on empty space from filing into nearest folder.
 */
export const mailFileCollisionDetection: CollisionDetection = (args) => {
  return pointerWithin(args);
};

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
