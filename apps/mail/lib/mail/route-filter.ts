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

/** Lowercase UUID (with or without hyphens) — used before labelIdSet hydrates. */
const LABEL_ID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `/mail/{param}` is a user My folders label id (not system/hotel slug). */
export function isUserFolderRouteParam(folder: string | undefined | null): boolean {
  if (!folder) return false;
  const raw = folder.trim();
  if (!raw) return false;
  const normalized = raw.toLowerCase();
  if (SYSTEM_FOLDERS.has(normalized)) return false;
  return LABEL_ID_SHAPE.test(raw);
}

/**
 * Archive list chrome + Move to Inbox: system archive OR My folders UUID route
 * (list filter is archive+labelIds for those paths).
 */
export function isArchiveLikeMailFolder(folder: string | undefined | null): boolean {
  const normalized = (folder ?? '').trim().toLowerCase();
  return normalized === 'archive' || normalized === 'archived' || isUserFolderRouteParam(folder);
}

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
  labelIdSet?: Set<string>,
): {
  folder: MailListFolderSlug;
  filters: { categoryIds?: string[]; labelIds?: string[] };
} {
  const raw = (folder ?? 'inbox').trim();
  const normalized = raw.toLowerCase();
  if (SYSTEM_FOLDERS.has(normalized))
    return { folder: normalized as MailListFolderSlug, filters: {} };
  const categoryId = categoryBySlug.get(normalized);
  if (categoryId) return { folder: 'inbox', filters: { categoryIds: [categoryId] } };
  if (labelIdSet?.has(normalized) || LABEL_ID_SHAPE.test(raw)) {
    return { folder: 'archive', filters: { labelIds: [normalized] } };
  }
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

/** Merge folder-route labelIds with search-hook labels (dedupe). */
export function mergeLabelIds(
  routeLabelIds: string[] | undefined,
  searchLabelIds: string[],
): string[] {
  return [...new Set([...(routeLabelIds ?? []), ...searchLabelIds])];
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
