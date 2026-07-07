const SYSTEM_FOLDERS = new Set([
  'inbox',
  'sent',
  'spam',
  'draft',
  'drafts',
  'archive',
  'archived',
  'bin',
  'starred',
  'snoozed',
  'all',
]);

export type MailListFolderSlug =
  | 'inbox'
  | 'sent'
  | 'spam'
  | 'draft'
  | 'drafts'
  | 'archive'
  | 'archived'
  | 'bin'
  | 'starred'
  | 'snoozed'
  | 'all';

export function resolveMailRouteFilter(
  folder: string | undefined,
  categoryBySlug: Map<string, string>,
): { folder: MailListFolderSlug; filters: { categoryIds?: string[] } } {
  const normalized = (folder ?? 'inbox').toLowerCase();
  if (SYSTEM_FOLDERS.has(normalized))
    return { folder: normalized as MailListFolderSlug, filters: {} };
  const categoryId = categoryBySlug.get(normalized);
  if (categoryId) return { folder: 'inbox', filters: { categoryIds: [categoryId] } };
  return { folder: 'inbox', filters: {} };
}
