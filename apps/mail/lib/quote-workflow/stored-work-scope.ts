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
