import { trpcClient } from '@/providers/query-provider';
import { FOLDERS } from '@/lib/utils';
import { isUserFolderRouteParam, isReservedSpamScopedLabelId } from '@/lib/mail/route-filter';

export type ThreadDestination = 'inbox' | 'archive' | 'spam' | 'bin' | 'snoozed' | null;
export type FolderLocation = 'inbox' | 'archive' | 'spam' | 'sent' | 'bin' | string;

export interface MoveThreadOptions {
  threadIds: string[];
  currentFolder: FolderLocation;
  destination: ThreadDestination;
}

export function isActionAvailable(
  folder: FolderLocation,
  action: ThreadDestination,
  _reservedSpamLabelIds?: Set<string> | readonly string[],
): boolean {
  if (!action) return false;

  // My folders UUID routes: archive-like (inbox+bin) or spam-scoped Quarantine (inbox+bin).
  if (isUserFolderRouteParam(folder)) {
    return action === 'inbox' || action === 'bin';
  }

  const pattern = `${folder}_to_${action}`;

  switch (pattern) {
    // From inbox rules
    case `${FOLDERS.INBOX}_to_spam`:
      return true;
    case `${FOLDERS.INBOX}_to_archive`:
      return true;
    case `${FOLDERS.INBOX}_to_bin`:
      return true;

    // From archive rules
    case `${FOLDERS.ARCHIVE}_to_inbox`:
      return true;
    case `${FOLDERS.ARCHIVE}_to_bin`:
      return true;

    // From spam rules
    case `${FOLDERS.SPAM}_to_inbox`:
      return true;
    case `${FOLDERS.SPAM}_to_bin`:
      return true;

    default:
      return false;
  }
}

export function getAvailableActions(
  folder: FolderLocation,
  reservedSpamLabelIds?: Set<string> | readonly string[],
): ThreadDestination[] {
  const allPossibleActions: ThreadDestination[] = ['inbox', 'archive', 'spam', 'bin', 'snoozed'];
  return allPossibleActions.filter((action) => isActionAvailable(folder, action, reservedSpamLabelIds));
}

export async function moveThreadsTo({ threadIds, destination }: MoveThreadOptions) {
  try {
    if (!threadIds.length || !destination) return;
    const moveDestinations = ['inbox', 'archive', 'spam', 'bin'] as const;
    type MoveDestination = (typeof moveDestinations)[number];
    if (!(moveDestinations as readonly string[]).includes(destination)) return;

    return trpcClient.mail.moveThreads.mutate({
      threadIds,
      destination: destination as MoveDestination,
    });
  } catch (error) {
    console.error(`Error moving thread(s):`, error);
    throw error;
  }
}

export interface FileThreadsOptions {
  threadIds: string[];
  labelId: string;
}

export async function fileThreadsTo({ threadIds, labelId }: FileThreadsOptions) {
  try {
    if (!threadIds.length || !labelId) return;
    return trpcClient.mail.fileThreads.mutate({ threadIds, labelId });
  } catch (error) {
    console.error(`Error filing thread(s):`, error);
    throw error;
  }
}

/** Prior filing state for optimistic rollback / undo restore. */
export type ThreadFilingSnapshot = {
  threadId: string;
  labelIds: string[];
  isArchived: boolean;
  isSpam: boolean;
  isTrashed: boolean;
};

export function buildThreadFilingSnapshots(
  threadIds: string[],
  currentFolder: string,
  cachedThreads: Array<{ id: string; labelIds?: string[] | null }>,
  reservedSpamLabelIds?: Set<string> | readonly string[],
): ThreadFilingSnapshot[] {
  const folder = currentFolder.toLowerCase();
  const isSpamScopedLabel = isReservedSpamScopedLabelId(currentFolder, reservedSpamLabelIds);
  const isArchived =
    folder === 'archive' ||
    folder === 'archived' ||
    (isUserFolderRouteParam(currentFolder) && !isSpamScopedLabel);
  const isSpam = folder === 'spam' || isSpamScopedLabel;
  const isTrashed = folder === 'bin' || folder === 'trash';
  const byId = new Map(cachedThreads.map((thread) => [thread.id, thread]));

  return threadIds.map((threadId) => {
    const cached = byId.get(threadId);
    return {
      threadId,
      labelIds: cached?.labelIds ? [...cached.labelIds] : [],
      isArchived,
      isSpam,
      isTrashed,
    };
  });
}

/** Collect labelIds from any cached infinite list pages (best-effort). */
export function collectCachedThreadLabelSources(
  queryEntries: Array<[unknown, unknown]>,
): Array<{ id: string; labelIds?: string[] | null }> {
  const out: Array<{ id: string; labelIds?: string[] | null }> = [];
  for (const [, data] of queryEntries) {
    if (!data || typeof data !== 'object') continue;
    const pages = (data as { pages?: unknown }).pages;
    if (!Array.isArray(pages)) continue;
    for (const page of pages) {
      if (!page || typeof page !== 'object') continue;
      const threads = (page as { threads?: unknown }).threads;
      if (!Array.isArray(threads)) continue;
      for (const thread of threads) {
        if (!thread || typeof thread !== 'object') continue;
        const id = (thread as { id?: unknown }).id;
        if (typeof id !== 'string') continue;
        const labelIds = (thread as { labelIds?: unknown }).labelIds;
        out.push({
          id,
          labelIds: Array.isArray(labelIds)
            ? labelIds.filter((value): value is string => typeof value === 'string')
            : [],
        });
      }
    }
  }
  return out;
}
