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

/**
 * tRPC call options that send the call under `transportId`, not whichever mailbox is active when it goes out. For a
 * save queued behind another that must still reach the mailbox it was made in after a mailbox switch.
 */
export function inMailbox(transportId: string | null): { context: { activeTransportId: string } } | undefined {
  return transportId ? { context: { activeTransportId: transportId } } : undefined;
}

/** The mailbox a tRPC call goes out under: the one inMailbox pinned, else the active one. */
export function transportForCall(context: Record<string, unknown> | undefined): string | null {
  const pinned = context?.activeTransportId;
  return typeof pinned === 'string' ? pinned : currentScope.activeTransportId;
}

export function idbCacheKeyForScope(scope: MailCacheScope): string {
  const user = scope.userId ?? 'anon';
  const transport = scope.activeTransportId ?? 'default';
  return `zero-query-cache-${user}-${transport}`;
}
