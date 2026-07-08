/** Map operator-only quick-filter queries to structured listThreads filters. */
export type MailListStructuredFilters = {
  unread?: boolean;
  starred?: boolean;
  important?: boolean;
  categoryIds?: string[];
  labelIds?: string[];
};

export type ResolvedMailListSearch = {
  q?: string;
  filters: MailListStructuredFilters;
};

const STATUS_ONLY = new Map<string, Partial<MailListStructuredFilters>>([
  ['is:unread', { unread: true }],
  ['is:starred', { starred: true }],
  ['is:important', { important: true }],
]);

/**
 * Pure status quick-filters → structured `filters.*` (plan trust layer).
 * Compound queries stay in `q` for server parser.
 */
export function resolveMailListSearch(
  q: string,
  baseFilters: MailListStructuredFilters,
): ResolvedMailListSearch {
  const trimmed = q.trim();
  if (!trimmed) {
    return { q: undefined, filters: baseFilters };
  }

  const statusOnly = STATUS_ONLY.get(trimmed.toLowerCase());
  if (statusOnly) {
    return {
      q: undefined,
      filters: { ...baseFilters, ...statusOnly },
    };
  }

  return { q: trimmed, filters: baseFilters };
}
