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
