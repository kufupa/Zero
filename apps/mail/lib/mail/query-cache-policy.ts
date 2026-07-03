import type { QueryClient } from '@tanstack/react-query';

export type LiveQueryHashScope = {
  userId: string;
  activeTransportId: string;
};

/** Stable prefix for queries fired before session + mailbox scope resolve. */
export const BOOTSTRAP_QUERY_HASH_PREFIX: LiveQueryHashScope = {
  userId: '__boot__',
  activeTransportId: '__boot__',
};

/** Prefix hashed into every live query key — scopes cache per user + mailbox. */
export function makeLiveQueryHashPrefix(scope: LiveQueryHashScope): LiveQueryHashScope {
  return {
    userId: scope.userId,
    activeTransportId: scope.activeTransportId,
  };
}

export type ScopeForQueryHash = {
  userId: string | null;
  activeTransportId: string | null;
};

/** One bootstrap prefix until both userId and activeTransportId are known. */
export function resolveQueryHashPrefix(scope: ScopeForQueryHash): LiveQueryHashScope {
  if (scope.userId && scope.activeTransportId) {
    return makeLiveQueryHashPrefix({
      userId: scope.userId,
      activeTransportId: scope.activeTransportId,
    });
  }
  return BOOTSTRAP_QUERY_HASH_PREFIX;
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
