import type { QuoteSelectionBinding } from './types';
import type { WorkstationEmailPayload } from '../workstation/bridge-protocol';

/** Give each selected item a fresh stored-work lookup without changing its mailbox binding. */
export function storedWorkScope(
  scope: string | null,
  transportId: string | null | undefined,
  selection: { storeId?: string | null; entryId: string } | null | undefined,
  ownerUserId: string | null | undefined,
): string | null {
  if (!scope || !transportId || !selection?.entryId || !ownerUserId) return null;
  const owner = encodeURIComponent(JSON.stringify([ownerUserId, selection.storeId ?? '', selection.entryId]));
  // Keep the transport suffix for the existing mailbox checks; the embedded owner survives session renewal.
  return `${scope}:web-work-v2=${owner}:${transportId}`;
}

/** The singleton used for request headers must name the user and mailbox encoded in this selected web row. */
export function storedWorkOwnerMatches(scope: string | null | undefined, entryId: string, owner: {
  userId: string | null; activeTransportId: string | null;
}): boolean {
  const { userId, activeTransportId } = owner;
  if (!scope || !userId || !activeTransportId || !scope.endsWith(`:${activeTransportId}`)) return false;
  const marker = ':web-work-v2=';
  const start = scope.lastIndexOf(marker);
  if (start < 0) return false;
  try {
    const identity = JSON.parse(decodeURIComponent(scope.slice(start + marker.length, -(activeTransportId.length + 1)))) as unknown;
    return Array.isArray(identity) && identity.length === 3 && identity[0] === userId &&
      typeof identity[1] === 'string' && identity[2] === entryId;
  } catch { return false; }
}

/** The reducer's binding may lag one render behind the selected email. */
export function isCurrentWorkSelection(
  binding: QuoteSelectionBinding,
  email: Pick<WorkstationEmailPayload, 'entryId' | 'storeId' | 'folderEntryId' | 'internetMessageId'> | null,
  epoch: { selectionEpoch: number; scopeEpoch: number },
): boolean {
  return Boolean(email && binding.entryId === email.entryId && binding.storeId === (email.storeId ?? '') &&
    binding.folderEntryId === (email.folderEntryId ?? '') &&
    (binding.internetMessageId ?? null) === (email.internetMessageId ?? null) &&
    binding.selectionEpoch === epoch.selectionEpoch && binding.scopeEpoch === epoch.scopeEpoch);
}
