import type { CSSProperties } from 'react';
import { isWorkflowFolderNavId } from '@/config/workflow-folders';

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

/** My Folder label names that route under spam folder + labelIds (not archive). */
export const RESERVED_SPAM_SCOPED_LABEL_NAMES = ['Quarantine'] as const;

export type ReservedSpamScopedLabelName = (typeof RESERVED_SPAM_SCOPED_LABEL_NAMES)[number];

/** True when label id is a reserved spam-scoped My Folder (e.g. Quarantine). */
export function isReservedSpamScopedLabelId(
  labelId: string | undefined | null,
  reservedSpamLabelIds?: Set<string> | readonly string[],
): boolean {
  if (!labelId || !reservedSpamLabelIds) return false;
  const normalized = labelId.trim().toLowerCase();
  if (reservedSpamLabelIds instanceof Set) return reservedSpamLabelIds.has(normalized);
  return reservedSpamLabelIds.some((id) => id.toLowerCase() === normalized);
}

/**
 * Build reserved spam-scoped label id set from user labels (name → UUID).
 * Callers with labels list (nav/hooks) pass result into route-filter + chrome helpers.
 */
export function buildReservedSpamLabelIdSet(
  labels: Array<{ id?: string | null; name?: string | null }>,
): Set<string> {
  const reservedNames = new Set(
    RESERVED_SPAM_SCOPED_LABEL_NAMES.map((name) => name.toLowerCase()),
  );
  const ids = new Set<string>();
  for (const label of labels) {
    const name = label.name?.trim().toLowerCase();
    if (label.id && name && reservedNames.has(name)) {
      ids.add(label.id.toLowerCase());
    }
  }
  return ids;
}

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
 * (list filter is archive+labelIds for those paths). Quarantine is spam-scoped.
 */
export function isArchiveLikeMailFolder(
  folder: string | undefined | null,
  reservedSpamLabelIds?: Set<string> | readonly string[],
): boolean {
  const normalized = (folder ?? '').trim().toLowerCase();
  if (normalized === 'archive' || normalized === 'archived') return true;
  if (isUserFolderRouteParam(folder)) {
    return !isReservedSpamScopedLabelId(folder, reservedSpamLabelIds);
  }
  return false;
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
  reservedSpamLabelIds?: Set<string>,
): {
  folder: MailListFolderSlug;
  filters: { categoryIds?: string[]; labelIds?: string[] };
} {
  const raw = (folder ?? 'inbox').trim();
  const normalized = raw.toLowerCase();
  if (SYSTEM_FOLDERS.has(normalized))
    return { folder: normalized as MailListFolderSlug, filters: {} };
  // Workflow URLs reuse legacy hotel slugs (new-bookings, groups-events). Membership
  // is workflowFolder on listThreads, not mail_thread_category.
  if (isWorkflowFolderNavId(normalized)) return { folder: 'inbox', filters: {} };
  const categoryId = categoryBySlug.get(normalized);
  if (categoryId) return { folder: 'inbox', filters: { categoryIds: [categoryId] } };
  if (labelIdSet?.has(normalized) || LABEL_ID_SHAPE.test(raw)) {
    if (isReservedSpamScopedLabelId(normalized, reservedSpamLabelIds)) {
      return { folder: 'spam', filters: { labelIds: [normalized] } };
    }
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
