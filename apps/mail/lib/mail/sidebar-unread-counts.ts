import type { Outputs } from '@zero/server/trpc';

export type MailUnreadFolderId = 'inbox' | 'sent' | 'archive' | 'snoozed' | 'bin' | 'spam';

export type PilotUnreadCounts = Outputs['mail']['unreadCounts'];

export type LegacyStat = {
  label: string;
  count: number;
};

export type SidebarUnreadCountSnapshot = {
  folders: Record<MailUnreadFolderId, number>;
  categories: Record<string, number>;
  labels: Record<string, number>;
  legacy: readonly LegacyStat[];
  source: 'pilot' | 'legacy' | 'none';
  scopeKey: string | null;
};

const DEFAULT_FOLDERS: Record<MailUnreadFolderId, number> = {
  inbox: 0,
  sent: 0,
  archive: 0,
  snoozed: 0,
  bin: 0,
  spam: 0,
};

export function toSidebarUnreadCountSnapshot(
  payload: PilotUnreadCounts | undefined,
  legacyStats: readonly LegacyStat[] | undefined,
  providerId: string | undefined,
  scopeKey: string | null = null,
): SidebarUnreadCountSnapshot {
  if (providerId === 'mailbox' && payload) {
    const folders: Record<MailUnreadFolderId, number> = { ...DEFAULT_FOLDERS };
    for (const f of payload.folders) {
      folders[f.id] = f.unreadCount;
    }

    const categories: Record<string, number> = {};
    for (const c of payload.categories) {
      categories[c.categoryId] = c.unreadCount;
    }

    const labels: Record<string, number> = {};
    for (const l of payload.labels) {
      labels[l.labelId] = l.unreadCount;
    }

    return {
      folders,
      categories,
      labels,
      legacy: legacyStats ?? [],
      source: 'pilot',
      scopeKey,
    };
  }

  if (legacyStats && legacyStats.length > 0) {
    return {
      folders: { ...DEFAULT_FOLDERS },
      categories: {},
      labels: {},
      legacy: legacyStats,
      source: 'legacy',
      scopeKey: null,
    };
  }

  return {
    folders: { ...DEFAULT_FOLDERS },
    categories: {},
    labels: {},
    legacy: legacyStats ?? [],
    source: 'none',
    scopeKey: null,
  };
}

/**
 * Returns unread count for a navigation item.
 * undefined = no badge contract (e.g. Drafts, synthetic group, or unknown)
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
