export function computeThreadListEnabled(input: {
  demoMode: boolean;
  sessionUserId: string | undefined;
  routeFolder: string | undefined;
}): boolean {
  const hasFolder = typeof input.routeFolder === 'string' && input.routeFolder.length > 0;
  if (!hasFolder) return false;
  if (input.demoMode) return true;
  return Boolean(input.sessionUserId);
}
