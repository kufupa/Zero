/** Show mailbox switcher chrome only when the user can actually switch. */
export function canManageConnections(connectionCount: number): boolean {
  return connectionCount > 1;
}
