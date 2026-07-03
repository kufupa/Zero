/** Runtime mailbox scope for query cache hashing + tRPC transport header. */
export type MailCacheScope = {
  userId: string | null;
  activeTransportId: string | null;
};

let currentScope: MailCacheScope = {
  userId: null,
  activeTransportId: null,
};

const scopeListeners = new Set<() => void>();

export function getMailCacheScope(): MailCacheScope {
  return currentScope;
}

export function subscribeMailCacheScope(listener: () => void): () => void {
  scopeListeners.add(listener);
  return () => {
    scopeListeners.delete(listener);
  };
}

export function setMailCacheScope(scope: MailCacheScope): void {
  const changed =
    currentScope.userId !== scope.userId ||
    currentScope.activeTransportId !== scope.activeTransportId;
  currentScope = scope;
  if (changed) {
    for (const listener of scopeListeners) {
      listener();
    }
  }
}

export function idbCacheKeyForScope(scope: MailCacheScope): string {
  const user = scope.userId ?? 'anon';
  const transport = scope.activeTransportId ?? 'default';
  return `zero-query-cache-${user}-${transport}`;
}
