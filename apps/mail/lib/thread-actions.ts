import { trpcClient } from '@/providers/query-provider';
import { FOLDERS } from '@/lib/utils';

export type ThreadDestination = 'inbox' | 'archive' | 'spam' | 'bin' | 'snoozed' | null;
export type FolderLocation = 'inbox' | 'archive' | 'spam' | 'sent' | 'bin' | string;

export interface MoveThreadOptions {
  threadIds: string[];
  currentFolder: FolderLocation;
  destination: ThreadDestination;
}

export function isActionAvailable(folder: FolderLocation, action: ThreadDestination): boolean {
  if (!action) return false;

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

export function getAvailableActions(folder: FolderLocation): ThreadDestination[] {
  const allPossibleActions: ThreadDestination[] = ['inbox', 'archive', 'spam', 'bin', 'snoozed'];
  return allPossibleActions.filter((action) => isActionAvailable(folder, action));
}

export async function moveThreadsTo({ threadIds, destination }: MoveThreadOptions) {
  try {
    if (!threadIds.length || !destination) return;
    if (!['inbox', 'archive', 'spam', 'bin'].includes(destination)) return;

    return trpcClient.mail.moveThreads.mutate({
      threadIds,
      destination,
    });
  } catch (error) {
    console.error(`Error moving thread(s):`, error);
    throw error;
  }
}
