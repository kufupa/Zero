/** Sidebar collapsible title for user filing labels (FO My folders). */
export const MY_FOLDERS_SIDEBAR_TITLE = 'My folders';

/** Providers that open My folders via `/mail/{labelId}` (archive+labelIds list). */
export const MY_FOLDERS_NAVIGATE_PROVIDERS = new Set(['mailbox', 'microsoft', 'google']);

/** Create `+` gate: mailbox (pilot) and google. */
export function shouldShowMyFoldersCreate(
  providerId: string | null | undefined,
): boolean {
  return providerId === 'mailbox' || providerId === 'google';
}

export function shouldNavigateMyFolderRoute(
  providerId: string | null | undefined,
): boolean {
  return Boolean(providerId && MY_FOLDERS_NAVIGATE_PROVIDERS.has(providerId));
}
