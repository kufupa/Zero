import { TRPCClientError } from '@trpc/client';
import type { MailListFolderSlug } from './route-filter';
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
};

export const EMPTY_SEARCH_VALUE: SearchValueState = {
  value: '',
  highlight: '',
  scope: 'folder',
  filters: [],
};

const RECENT_SEARCHES_KEY = 'mail-recent-searches';
const MAX_SEARCH_QUERY_LENGTH = 512;

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

export function loadRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRecentSearch(search: string): void {
  const trimmed = search.trim();
  if (!trimmed) return;
  try {
    const next = [trimmed, ...loadRecentSearches().filter((item) => item !== trimmed)].slice(0, 10);
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
  } catch {
    // private mode / quota — ignore
  }
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
}): {
  folder: MailListFolderSlug;
  filters: MailListStructuredFilters;
  q?: string;
  useDraftsList: boolean;
} {
  const merged = mergeSearchQuery(input.query, input.filters);
  const hasQuery = merged.length > 0;
  const isDraftRoute =
    input.routeResolved.folder === 'draft' || input.routeResolved.folder === 'drafts';

  if (!hasQuery) {
    return {
      folder: input.routeResolved.folder,
      filters: input.baseFilters,
      q: undefined,
      useDraftsList: isDraftRoute,
    };
  }

  if (merged.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new RangeError(`Search query must be ${MAX_SEARCH_QUERY_LENGTH} characters or fewer`);
  }

  if (input.scope === 'all') {
    const { categoryIds: _categoryIds, labelIds: _labelIds, ...kept } = input.baseFilters;
    const resolved = resolveMailListSearch(merged, kept);
    const q = resolved.q ?? merged;
    return {
      folder: 'all',
      filters: resolved.filters,
      q,
      useDraftsList: false,
    };
  }

  const resolved = resolveMailListSearch(merged, input.baseFilters);
  const q = resolved.q ?? merged;
  return {
    folder: input.routeResolved.folder,
    filters: resolved.filters,
    q,
    useDraftsList: isDraftRoute,
  };
}
