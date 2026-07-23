import type { CSSProperties } from 'react';

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

/** Toggle hotel category chip by id (not searchValue / label). */
export function toggleCategoryChip(selectedIds: string[], categoryId: string): string[] {
  const id = categoryId.trim();
  if (!id) return [];
  if (selectedIds.includes(id)) return selectedIds.filter((x) => x !== id);
  return [...selectedIds, id];
}

/** Shape useThreads passes into listThreads (categoryIds ≠ labelIds). */
export function buildListThreadsInput(opts: {
  categoryIds?: string[];
  labels?: string[];
}): { filters: { categoryIds: string[] }; labelIds: string[] } {
  return {
    filters: { categoryIds: opts.categoryIds ?? [] },
    labelIds: opts.labels ?? [],
  };
}

/** Merge folder-route categoryIds with URL query categoryIds (dedupe). */
export function mergeCategoryIds(
  routeCategoryIds: string[] | undefined,
  queryCategoryIds: string[],
): string[] {
  return [...new Set([...(routeCategoryIds ?? []), ...queryCategoryIds])];
}

export function parseCategoryIdsParam(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/** Nav / chip style from category.color hex (or empty → no theme). */
export function categoryColorNavTheme(color?: string | null): {
  style?: CSSProperties;
  className?: string;
} {
  if (!color?.trim()) return {};
  const c = color.trim();
  return {
    style: {
      '--centurion-sidebar-bg': c,
      '--centurion-sidebar-text': '#FFFFFF',
      '--centurion-sidebar-bg-dark': c,
      '--centurion-sidebar-text-dark': '#FFFFFF',
    } as CSSProperties,
    className:
      'bg-[var(--centurion-sidebar-bg)] text-[var(--centurion-sidebar-text)] dark:bg-[var(--centurion-sidebar-bg-dark)] dark:text-[var(--centurion-sidebar-text-dark)]',
  };
}
