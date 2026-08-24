import { describe, expect, it, vi } from 'vitest';
import { resolveMailRouteFilter } from '../lib/mail/route-filter';
import {
  attachmentFilter,
  fromFilter,
  last7DaysFilter,
  loadRecentSearches,
  mergeSearchQuery,
  resolveSearchListRequest,
  toggleSearchFilter,
  unreadFilter,
} from '../lib/mail/search-list';

describe('search-list helpers', () => {
  it('merges free text with optional filter tokens', () => {
    expect(mergeSearchQuery('Isaac', [])).toBe('Isaac');
    expect(mergeSearchQuery('Isaac', [fromFilter('Isaac')!])).toBe('Isaac from:Isaac');
    expect(mergeSearchQuery('  ', [unreadFilter()])).toBe('is:unread');
  });

  it('toggles filters by type and starts with none applied', () => {
    expect(toggleSearchFilter([], unreadFilter())).toEqual([unreadFilter()]);
    expect(toggleSearchFilter([unreadFilter()], unreadFilter())).toEqual([]);
    expect(toggleSearchFilter([unreadFilter()], attachmentFilter())).toEqual([
      unreadFilter(),
      attachmentFilter(),
    ]);
  });

  it('builds from: from typed name and ignores empty', () => {
    expect(fromFilter('')).toBeNull();
    expect(fromFilter('Isaac')?.value).toBe('from:Isaac');
    expect(fromFilter('Isaac Stern')?.value).toBe('from:"Isaac Stern"');
  });

  it('uses UTC last-7-days after: token', () => {
    expect(last7DaysFilter(new Date('2026-08-24T12:00:00Z')).value).toBe('after:2026/08/17');
  });

  it('keeps this-folder category search on hotel slug', () => {
    const routeResolved = resolveMailRouteFilter(
      'new-bookings',
      new Map([['new-bookings', 'cat-new-bookings']]),
    );
    const result = resolveSearchListRequest({
      scope: 'folder',
      query: 'deposit',
      filters: [],
      routeResolved,
      baseFilters: { categoryIds: ['cat-new-bookings'] },
    });
    expect(result.folder).toBe('inbox');
    expect(result.filters.categoryIds).toEqual(['cat-new-bookings']);
    expect(result.q).toBe('deposit');
    expect(result.useDraftsList).toBe(false);
  });

  it('all-folders plus query drops route categoryIds and uses folder all', () => {
    const routeResolved = resolveMailRouteFilter(
      'new-bookings',
      new Map([['new-bookings', 'cat-new-bookings']]),
    );
    const result = resolveSearchListRequest({
      scope: 'all',
      query: 'deposit',
      filters: [],
      routeResolved,
      baseFilters: { categoryIds: ['cat-new-bookings'] },
    });
    expect(result.folder).toBe('all');
    expect(result.filters.categoryIds).toBeUndefined();
    expect(result.useDraftsList).toBe(false);
  });

  it('empty query ignores all-folders so mailbox list is not dumped', () => {
    const routeResolved = resolveMailRouteFilter('inbox', new Map());
    const result = resolveSearchListRequest({
      scope: 'all',
      query: '',
      filters: [],
      routeResolved,
      baseFilters: {},
    });
    expect(result.folder).toBe('inbox');
    expect(result.q).toBeUndefined();
    expect(result.useDraftsList).toBe(false);
  });

  it('treats filter-only query as active search', () => {
    const routeResolved = resolveMailRouteFilter('inbox', new Map());
    const result = resolveSearchListRequest({
      scope: 'folder',
      query: '',
      filters: [unreadFilter()],
      routeResolved,
      baseFilters: {},
    });
    expect(result.q).toBe('is:unread');
    expect(result.folder).toBe('inbox');
  });

  it('keeps typed status-only grammar in q and structured filters', () => {
    const result = resolveSearchListRequest({
      scope: 'folder',
      query: 'is:unread',
      filters: [],
      routeResolved: resolveMailRouteFilter('inbox', new Map()),
      baseFilters: {},
    });
    expect(result.q).toBe('is:unread');
    expect(result.filters).toEqual({ unread: true });
  });

  it('rejects a request query longer than server limit', () => {
    const query = 'x'.repeat(512);
    const routeResolved = resolveMailRouteFilter('inbox', new Map());
    expect(
      resolveSearchListRequest({
        scope: 'folder',
        query,
        filters: [],
        routeResolved,
        baseFilters: {},
      }).q,
    ).toBe(query);
    expect(() =>
      resolveSearchListRequest({
        scope: 'folder',
        query,
        filters: [unreadFilter()],
        routeResolved,
        baseFilters: {},
      }),
    ).toThrow('Search query must be 512 characters or fewer');
  });

  it('rejects non-string recent-search storage entries', () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(['valid', 1]) });
    try {
      expect(loadRecentSearches()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('searches all folders for filter-only all scope', () => {
    const routeResolved = resolveMailRouteFilter('inbox', new Map());
    const result = resolveSearchListRequest({
      scope: 'all',
      query: '',
      filters: [unreadFilter()],
      routeResolved,
      baseFilters: {},
    });
    expect(result.folder).toBe('all');
    expect(result.q).toBe('is:unread');
  });

  it('keeps draft folder search on drafts.list but uses mail for all folders', () => {
    const routeResolved = resolveMailRouteFilter('draft', new Map());
    const inDrafts = resolveSearchListRequest({
      scope: 'folder',
      query: 'menu',
      filters: [],
      routeResolved,
      baseFilters: {},
    });
    expect(inDrafts.useDraftsList).toBe(true);
    expect(inDrafts.folder).toBe('draft');

    const allMail = resolveSearchListRequest({
      scope: 'all',
      query: 'menu',
      filters: [],
      routeResolved,
      baseFilters: {},
    });
    expect(allMail.useDraftsList).toBe(false);
    expect(allMail.folder).toBe('all');
  });
});
