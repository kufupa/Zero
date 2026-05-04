/**
 * Canonical URL segments for first-party mail list routes (legacy / hosted).
 * Demo-only category folders (Centurion) stay in `lib/demo/folder-map`.
 */
export const STANDARD_MAIL_FOLDER_SLUGS = [
  'inbox',
  'draft',
  'sent',
  'spam',
  'bin',
  'archive',
  'snoozed',
] as const;

export type StandardMailFolderSlug = (typeof STANDARD_MAIL_FOLDER_SLUGS)[number];

const STANDARD_SLUG_SET = new Set<string>(STANDARD_MAIL_FOLDER_SLUGS);

export function isStandardMailFolderSlug(folder: string | undefined | null): boolean {
  if (folder == null || !folder.trim()) return false;
  return STANDARD_SLUG_SET.has(folder.trim().toLowerCase());
}
