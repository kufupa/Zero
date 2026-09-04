import type { Outputs } from '@zero/server/trpc';

export type MailUnreadFolderId = 'inbox' | 'sent' | 'archive' | 'snoozed' | 'bin' | 'spam';

export type PilotUnreadCounts = Outputs['mail']['unreadCounts'];

export type LegacyStat = {
  label: string;
  count: number;
};

export type FolderCountData = {
  unread: number;
  total: number;
};

export type SidebarUnreadCountSnapshot = {
  folders: Record<MailUnreadFolderId, number>;
  categories: Record<string, number>;
  labels: Record<string, number>;
  folderTotals: Record<MailUnreadFolderId, number>;
  categoryTotals: Record<string, number>;
  labelTotals: Record<string, number>;
  draftsCount: number;
  legacy: readonly LegacyStat[];
  source: 'pilot' | 'legacy' | 'none';
  scopeKey: string | null;
  hasData: boolean;
  getCount: (key: string, categoryIdForSlug?: string) => number | undefined;
  getTotal: (key: string, categoryIdForSlug?: string) => number | undefined;
  getTooltip: (key: string, title?: string, categoryIdForSlug?: string) => string;
};

const DEFAULT_FOLDERS: Record<MailUnreadFolderId, number> = {
  inbox: 0,
  sent: 0,
  archive: 0,
  snoozed: 0,
  bin: 0,
  spam: 0,
};

export function formatFolderTooltip(
  title: string | undefined,
  unreadCount: number | undefined,
  totalCount: number | undefined,
  isDrafts?: boolean,
): string {
  if (isDrafts) {
    const drafts = unreadCount ?? totalCount ?? 0;
    return `${drafts} active ${drafts === 1 ? 'draft' : 'drafts'}`;
  }

  const unread = unreadCount ?? 0;
  if (totalCount !== undefined) {
    const threadLabel = totalCount === 1 ? 'thread' : 'threads';
    if (unread > 0) {
      return `${unread} unread of ${totalCount} ${threadLabel}`;
    }
    return `${totalCount} ${threadLabel} (all read)`;
  }

  if (unread > 0) {
    return `${unread} unread`;
  }

  return title ? `${title} (all read)` : 'All read';
}

export function toSidebarUnreadCountSnapshot(
  payload: PilotUnreadCounts | undefined,
  legacyStats: readonly LegacyStat[] | undefined,
  providerId: string | undefined,
  scopeKey: string | null = null,
): SidebarUnreadCountSnapshot {
  const isPilot = providerId === 'mailbox' && Boolean(payload);

  const folders: Record<MailUnreadFolderId, number> = { ...DEFAULT_FOLDERS };
  const folderTotals: Record<MailUnreadFolderId, number> = { ...DEFAULT_FOLDERS };
  const categories: Record<string, number> = {};
  const categoryTotals: Record<string, number> = {};
  const labels: Record<string, number> = {};
  const labelTotals: Record<string, number> = {};
  let draftsCount = 0;

  if (isPilot && payload) {
    for (const f of payload.folders) {
      folders[f.id] = f.unreadCount;
      folderTotals[f.id] = f.totalCount ?? f.unreadCount;
    }

    for (const c of payload.categories) {
      categories[c.categoryId] = c.unreadCount;
      categoryTotals[c.categoryId] = c.totalCount ?? c.unreadCount;
    }

    for (const l of payload.labels) {
      labels[l.labelId] = l.unreadCount;
      labelTotals[l.labelId] = l.totalCount ?? l.unreadCount;
    }

    draftsCount = payload.draftsCount ?? 0;
  }

  const source: 'pilot' | 'legacy' | 'none' = isPilot
    ? 'pilot'
    : legacyStats && legacyStats.length > 0
      ? 'legacy'
      : 'none';

  const hasData =
    source === 'pilot' ? true : source === 'legacy' ? (legacyStats?.length ?? 0) > 0 : false;

  const snapshot: SidebarUnreadCountSnapshot = {
    folders,
    folderTotals,
    categories,
    categoryTotals,
    labels,
    labelTotals,
    draftsCount,
    legacy: legacyStats ?? [],
    source,
    scopeKey: isPilot ? scopeKey : null,
    hasData,
    getCount: (key: string, categoryIdForSlug?: string) => {
      const navCount = getNavUnreadCount(snapshot, key, categoryIdForSlug);
      if (navCount !== undefined) return navCount;
      return getLabelUnreadCount(snapshot, key);
    },
    getTotal: (key: string, categoryIdForSlug?: string) => {
      return getFolderTotal(snapshot, key, categoryIdForSlug);
    },
    getTooltip: (key: string, title?: string, categoryIdForSlug?: string) => {
      const normalizedKey = key.trim().toLowerCase();
      const isDrafts = normalizedKey === 'drafts' || normalizedKey === 'draft';
      const unread = isDrafts ? snapshot.draftsCount : snapshot.getCount(key, categoryIdForSlug);
      const total = isDrafts ? snapshot.draftsCount : snapshot.getTotal(key, categoryIdForSlug);
      return formatFolderTooltip(title ?? key, unread, total, isDrafts);
    },
  };

  return snapshot;
}

/**
 * Returns unread count for a navigation item.
 * undefined = no badge contract (e.g. unknown item or 0 drafts)
 * number >= 0 = badge count (render when > 0)
 */
export function getNavUnreadCount(
  snapshot: SidebarUnreadCountSnapshot | undefined,
  itemId: string | undefined,
  categoryIdForSlug?: string,
): number | undefined {
  if (!snapshot || snapshot.source === 'none' || !itemId) {
    return undefined;
  }

  const normalizedId = itemId.trim().toLowerCase();
  if (normalizedId === 'drafts' || normalizedId === 'draft') {
    if (snapshot.source === 'pilot') {
      return snapshot.draftsCount > 0 ? snapshot.draftsCount : undefined;
    }
    if (snapshot.source === 'legacy') {
      const stat = snapshot.legacy.find((s) => {
        const lbl = s.label?.trim().toLowerCase();
        return lbl === 'drafts' || lbl === 'draft';
      });
      return stat && stat.count > 0 ? stat.count : undefined;
    }
    return undefined;
  }

  if (snapshot.source === 'pilot') {
    const folderKey = normalizedId === 'trash' ? 'bin' : (normalizedId as MailUnreadFolderId);
    if (folderKey in snapshot.folders) {
      return snapshot.folders[folderKey] ?? 0;
    }

    if (categoryIdForSlug && categoryIdForSlug in snapshot.categories) {
      return snapshot.categories[categoryIdForSlug] ?? 0;
    }

    if (itemId in snapshot.categories) {
      return snapshot.categories[itemId] ?? 0;
    }

    return undefined;
  }

  if (snapshot.source === 'legacy') {
    const targetLabel = normalizedId === 'trash' ? 'trash' : normalizedId;
    const stat = snapshot.legacy.find((s) => s.label?.trim().toLowerCase() === targetLabel);
    return stat ? stat.count : undefined;
  }

  return undefined;
}

/**
 * Returns total thread count for a navigation item, category, or label.
 */
export function getFolderTotal(
  snapshot: SidebarUnreadCountSnapshot | undefined,
  itemId: string | undefined,
  categoryIdForSlug?: string,
): number | undefined {
  if (!snapshot || snapshot.source === 'none' || !itemId) {
    return undefined;
  }

  const normalizedId = itemId.trim().toLowerCase();
  if (normalizedId === 'drafts' || normalizedId === 'draft') {
    return snapshot.source === 'pilot' ? snapshot.draftsCount : undefined;
  }

  if (snapshot.source === 'pilot') {
    const folderKey = normalizedId === 'trash' ? 'bin' : (normalizedId as MailUnreadFolderId);
    if (folderKey in snapshot.folderTotals) {
      return snapshot.folderTotals[folderKey] ?? 0;
    }

    if (categoryIdForSlug && categoryIdForSlug in snapshot.categoryTotals) {
      return snapshot.categoryTotals[categoryIdForSlug] ?? 0;
    }

    if (itemId in snapshot.categoryTotals) {
      return snapshot.categoryTotals[itemId] ?? 0;
    }

    if (itemId in snapshot.labelTotals) {
      return snapshot.labelTotals[itemId] ?? 0;
    }

    return undefined;
  }

  return undefined;
}

/**
 * Returns unread count for a user label / My Folder item.
 * undefined = no badge contract (e.g. synthetic parent groups like 'group-*')
 * number >= 0 = badge count (render when > 0)
 */
export function getLabelUnreadCount(
  snapshot: SidebarUnreadCountSnapshot | undefined,
  labelId: string | undefined,
  labelName?: string,
): number | undefined {
  if (!snapshot || snapshot.source === 'none') {
    return undefined;
  }

  if (labelId && labelId.startsWith('group-')) {
    return undefined;
  }

  if (snapshot.source === 'pilot') {
    if (labelId && labelId in snapshot.labels) {
      return snapshot.labels[labelId] ?? 0;
    }
    return undefined;
  }

  if (snapshot.source === 'legacy') {
    if (!labelName) return undefined;
    const stat = snapshot.legacy.find(
      (s) => s.label?.trim().toLowerCase() === labelName.trim().toLowerCase(),
    );
    return stat ? stat.count : undefined;
  }

  return undefined;
}

