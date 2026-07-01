/** Runtime mailbox scope for query cache hashing + tRPC transport header. */
export type MailCacheScope = {
  userId: string | null;
  activeTransportId: string | null;
};

let currentScope: MailCacheScope = {
  userId: null,
  activeTransportId: null,
};

export function getMailCacheScope(): MailCacheScope {
  return currentScope;
}

export function setMailCacheScope(scope: MailCacheScope): void {
  currentScope = scope;
}

export function idbCacheKeyForScope(scope: MailCacheScope): string {
  const user = scope.userId ?? 'anon';
  const transport = scope.activeTransportId ?? 'default';
  return `zero-query-cache-${user}-${transport}`;
}
