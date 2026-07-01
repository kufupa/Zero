import type { QueryClient } from '@tanstack/react-query';

export type LiveQueryHashScope = {
  userId: string;
  activeTransportId: string;
};

/** Prefix hashed into every live query key — scopes cache per user + mailbox. */
export function makeLiveQueryHashPrefix(scope: LiveQueryHashScope): LiveQueryHashScope {
  return {
    userId: scope.userId,
    activeTransportId: scope.activeTransportId,
  };
}

export type LogoutCleanupDeps = {
  queryClient: Pick<QueryClient, 'clear'>;
  clearIdb: () => Promise<void>;
};

/** Clear React Query memory cache and IndexedDB persisted cache on auth boundary. */
export async function runLogoutCleanup(deps: LogoutCleanupDeps): Promise<{
  queryClient: boolean;
  idb: boolean;
}> {
  deps.queryClient.clear();
  await deps.clearIdb();
  return { queryClient: true, idb: true };
}
