import { TRPCClientError } from '@trpc/client';
import type { MailListFolderSlug } from './route-filter';
import { getMailCacheScope } from './mail-cache-scope';
import {
  resolveMailListSearch,
  type MailListStructuredFilters,
} from './search-filters';

export type SearchScope = 'folder' | 'all';

export type SearchFilterType = 'from' | 'has-attachment' | 'unread' | 'date';

export type ActiveSearchFilter = {
  type: SearchFilterType;
  value: string;
  display: string;
};

export type SearchValueState = {
  value: string;
  highlight: string;
  scope: SearchScope;
  filters: ActiveSearchFilter[];
  resetVersion: number;
};

export const EMPTY_SEARCH_VALUE: SearchValueState = {
  value: '',
  highlight: '',
  scope: 'folder',
  filters: [],
  resetVersion: 0,
};

const LEGACY_RECENT_SEARCHES_KEY = 'mail-recent-searches';
const SCOPED_RECENT_SEARCHES_KEY_PREFIX = 'mail-recent-searches-v2';
export const MAX_EFFECTIVE_SEARCH_LENGTH = 512;
export const SEARCH_QUERY_TOO_LONG_MESSAGE = 'Search query must be 512 characters or fewer.';

export function mergeSearchQuery(term: string, filters: ActiveSearchFilter[]): string {
  const parts = [term.trim(), ...filters.map((filter) => filter.value.trim())].filter(Boolean);
  return parts.join(' ');
}

export function toggleSearchFilter(
  filters: ActiveSearchFilter[],
  next: ActiveSearchFilter,
): ActiveSearchFilter[] {
  const existing = filters.find((filter) => filter.type === next.type);
  if (existing && existing.value === next.value) {
    return filters.filter((filter) => filter.type !== next.type);
  }
  return [...filters.filter((filter) => filter.type !== next.type), next];
}

export function fromFilter(raw: string): ActiveSearchFilter | null {
  const needle = raw.trim();
  if (!needle) return null;
  const value = needle.includes(' ') ? `from:"${needle}"` : `from:${needle}`;
  return { type: 'from', value, display: `From: ${needle}` };
}

export function unreadFilter(): ActiveSearchFilter {
  return { type: 'unread', value: 'is:unread', display: 'Unread' };
}

export function attachmentFilter(): ActiveSearchFilter {
  return { type: 'has-attachment', value: 'has:attachment', display: 'Has attachment' };
}

export function last7DaysFilter(now = new Date()): ActiveSearchFilter {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 7);
  const stamp = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
  return { type: 'date', value: `after:${stamp}`, display: 'Last 7 days' };
}

export function isUnsupportedSearchOperatorError(error: unknown): boolean {
  if (!(error instanceof TRPCClientError)) return false;
  return (
    error.data?.code === 'BAD_REQUEST' &&
    typeof error.message === 'string' &&
    error.message.includes('unsupported search operator')
  );
}

function getRecentSearchesKey(): string | null {
  const { userId, activeTransportId } = getMailCacheScope();
  if (!userId || !activeTransportId) return null;
  return `${SCOPED_RECENT_SEARCHES_KEY_PREFIX}:${encodeURIComponent(
    userId,
  )}:${encodeURIComponent(activeTransportId)}`;
}

export function removeLegacyRecentSearches(): void {
  try {
    localStorage.removeItem(LEGACY_RECENT_SEARCHES_KEY);
  } catch {
    // private mode / unavailable storage — ignore
  }
}

export function loadRecentSearches(): string[] {
  const key = getRecentSearchesKey();
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRecentSearch(search: string): void {
  const trimmed = search.trim();
  if (!trimmed) return;
  const key = getRecentSearchesKey();
  if (!key) return;
  try {
    const next = [trimmed, ...loadRecentSearches().filter((item) => item !== trimmed)].slice(0, 10);
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // private mode / quota — ignore
  }
}

export type ValidSearchListRequest = {
  isValid: true;
  effectiveQuery: string;
  folder: MailListFolderSlug;
  filters: MailListStructuredFilters;
  q?: string;
  useDraftsList: boolean;
};

export type InvalidSearchListRequest = {
  isValid: false;
  error: 'QUERY_TOO_LONG';
  effectiveQuery: string;
};

export type SearchListRequest = ValidSearchListRequest | InvalidSearchListRequest;

function omitRouteOwnedIds(
  ids: string[] | undefined,
  routeOwnedIds: string[] | undefined,
): string[] | undefined {
  if (!ids?.length) return undefined;
  const routeOwned = new Set(routeOwnedIds ?? []);
  const kept = ids.filter((id) => !routeOwned.has(id));
  return kept.length > 0 ? kept : undefined;
}

export function resolveSearchListRequest(input: {
  scope: SearchScope;
  query: string;
  filters: ActiveSearchFilter[];
  routeResolved: {
    folder: MailListFolderSlug;
    filters: { categoryIds?: string[]; labelIds?: string[] };
  };
  baseFilters: MailListStructuredFilters;
  userFilters?: Pick<MailListStructuredFilters, 'categoryIds' | 'labelIds'>;
}): SearchListRequest {
  const isDraftRoute =
    input.routeResolved.folder === 'draft' || input.routeResolved.folder === 'drafts';
  const effectiveFilters = isDraftRoute && input.scope === 'folder' ? [] : input.filters;
  const merged = mergeSearchQuery(input.query, effectiveFilters);
  const hasQuery = merged.length > 0;

  if (!hasQuery) {
    return {
      isValid: true,
      effectiveQuery: merged,
      folder: input.routeResolved.folder,
      filters: input.baseFilters,
      q: undefined,
      useDraftsList: isDraftRoute,
    };
  }

  if (merged.length > MAX_EFFECTIVE_SEARCH_LENGTH) {
    return {
      isValid: false,
      error: 'QUERY_TOO_LONG',
      effectiveQuery: merged,
    };
  }

  if (input.scope === 'all') {
    const { categoryIds, labelIds, ...kept } = input.baseFilters;
    const allFolderFilters: MailListStructuredFilters = {
      ...kept,
      ...(input.userFilters?.categoryIds?.length
        ? { categoryIds: input.userFilters.categoryIds }
        : input.userFilters
          ? {}
          : { categoryIds: omitRouteOwnedIds(categoryIds, input.routeResolved.filters.categoryIds) }),
      ...(input.userFilters?.labelIds?.length
        ? { labelIds: input.userFilters.labelIds }
        : input.userFilters
          ? {}
          : { labelIds: omitRouteOwnedIds(labelIds, input.routeResolved.filters.labelIds) }),
    };
    const resolved = resolveMailListSearch(merged, allFolderFilters);
    const q = resolved.q ?? merged;
    return {
      isValid: true,
      effectiveQuery: merged,
      folder: 'all',
      filters: resolved.filters,
      q,
      useDraftsList: false,
    };
  }

  const resolved = resolveMailListSearch(merged, input.baseFilters);
  const q = resolved.q ?? merged;
  return {
    isValid: true,
    effectiveQuery: merged,
    folder: input.routeResolved.folder,
    filters: resolved.filters,
    q,
    useDraftsList: isDraftRoute,
  };
}
