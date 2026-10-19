import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveMailRouteFilter } from '../lib/mail/route-filter';
import { setMailCacheScope } from '../lib/mail/mail-cache-scope';
import * as searchListHelpers from '../lib/mail/search-list';
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

function expectValidSearchListRequest(result: ReturnType<typeof resolveSearchListRequest>) {
  expect(result.isValid).toBe(true);
  if (!result.isValid) throw new Error(result.error);
  return result;
}

describe('search-list helpers', () => {
  afterEach(() => {
    setMailCacheScope({ userId: null, activeTransportId: null });
  });

  it('exports one effective-query limit and user-facing message', () => {
    const helpers = searchListHelpers as unknown as Record<string, unknown>;

    expect(helpers.MAX_EFFECTIVE_SEARCH_LENGTH).toBe(512);
    expect(helpers.SEARCH_QUERY_TOO_LONG_MESSAGE).toBe(
      'Search query must be 512 characters or fewer.',
    );
  });

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
      'at-risk',
      new Map([['at-risk', 'cat-at-risk']]),
    );
    const result = expectValidSearchListRequest(resolveSearchListRequest({
      scope: 'folder',
      query: 'deposit',
      filters: [],
      routeResolved,
      baseFilters: { categoryIds: ['cat-at-risk'] },
    }));
    expect(result.folder).toBe('inbox');
    expect(result.filters.categoryIds).toEqual(['cat-at-risk']);
    expect(result.q).toBe('deposit');
    expect(result.useDraftsList).toBe(false);
  });

  it('all-folders plus query drops route categoryIds and uses folder all', () => {
    const routeResolved = resolveMailRouteFilter(
      'at-risk',
      new Map([['at-risk', 'cat-at-risk']]),
    );
    const result = expectValidSearchListRequest(resolveSearchListRequest({
      scope: 'all',
      query: 'deposit',
      filters: [],
      routeResolved,
      baseFilters: { categoryIds: ['cat-at-risk'] },
    }));
    expect(result.folder).toBe('all');
    expect(result.filters.categoryIds).toBeUndefined();
    expect(result.useDraftsList).toBe(false);
  });

  it('keeps user-selected category and label filters when searching all folders', () => {
    const result = expectValidSearchListRequest(resolveSearchListRequest({
      scope: 'all',
      query: 'deposit',
      filters: [],
      routeResolved: {
        folder: 'inbox',
        filters: {
          categoryIds: ['route-category'],
          labelIds: ['route-label'],
        },
      },
      baseFilters: {
        categoryIds: ['route-category', 'selected-category'],
        labelIds: ['route-label', 'selected-label'],
      },
    }));

    expect(result.folder).toBe('all');
    expect(result.filters).toEqual({
      categoryIds: ['selected-category'],
      labelIds: ['selected-label'],
    });
  });

  it('keeps a user-selected filter even when route uses the same id', () => {
    const result = expectValidSearchListRequest(resolveSearchListRequest({
      scope: 'all',
      query: 'deposit',
      filters: [],
      routeResolved: {
        folder: 'inbox',
        filters: {
          categoryIds: ['shared-category'],
          labelIds: ['shared-label'],
        },
      },
      baseFilters: {
        categoryIds: ['shared-category'],
        labelIds: ['shared-label'],
      },
      userFilters: {
        categoryIds: ['shared-category'],
        labelIds: ['shared-label'],
      },
    }));

    expect(result.filters).toEqual({
      categoryIds: ['shared-category'],
      labelIds: ['shared-label'],
    });
  });

  it('empty query ignores all-folders so mailbox list is not dumped', () => {
    const routeResolved = resolveMailRouteFilter('inbox', new Map());
    const result = expectValidSearchListRequest(resolveSearchListRequest({
      scope: 'all',
      query: '',
      filters: [],
      routeResolved,
      baseFilters: {},
    }));
    expect(result.folder).toBe('inbox');
    expect(result.q).toBeUndefined();
    expect(result.useDraftsList).toBe(false);
  });

  it('treats filter-only query as active search', () => {
    const routeResolved = resolveMailRouteFilter('inbox', new Map());
    const result = expectValidSearchListRequest(resolveSearchListRequest({
      scope: 'folder',
      query: '',
      filters: [unreadFilter()],
      routeResolved,
      baseFilters: {},
    }));
    expect(result.q).toBe('is:unread');
    expect(result.folder).toBe('inbox');
  });

  it('keeps typed status-only grammar in q and structured filters', () => {
    const result = expectValidSearchListRequest(resolveSearchListRequest({
      scope: 'folder',
      query: 'is:unread',
      filters: [],
      routeResolved: resolveMailRouteFilter('inbox', new Map()),
      baseFilters: {},
    }));
    expect(result.q).toBe('is:unread');
    expect(result.filters).toEqual({ unread: true });
  });

  it('returns a non-forwardable invalid result over server query limit', () => {
    const query = 'x'.repeat(512);
    const routeResolved = resolveMailRouteFilter('inbox', new Map());
    const valid = expectValidSearchListRequest(resolveSearchListRequest({
      scope: 'folder',
      query,
      filters: [],
      routeResolved,
      baseFilters: {},
    }));
    expect(valid).toMatchObject({ isValid: true, effectiveQuery: query, q: query });

    const invalid = resolveSearchListRequest({
      scope: 'folder',
      query,
      filters: [unreadFilter()],
      routeResolved,
      baseFilters: {},
    });
    expect(invalid).toEqual({
      isValid: false,
      error: 'QUERY_TOO_LONG',
      effectiveQuery: `${query} is:unread`,
    });
    expect('q' in invalid).toBe(false);
    expect('folder' in invalid).toBe(false);
    expect('filters' in invalid).toBe(false);
  });

  it('rejects non-string recent-search storage entries', () => {
    setMailCacheScope({ userId: 'user-one', activeTransportId: 'transport-one' });
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(['valid', 1]) });
    try {
      expect(loadRecentSearches()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('searches all folders for filter-only all scope', () => {
    const routeResolved = resolveMailRouteFilter('inbox', new Map());
    const result = expectValidSearchListRequest(resolveSearchListRequest({
      scope: 'all',
      query: '',
      filters: [unreadFilter()],
      routeResolved,
      baseFilters: {},
    }));
    expect(result.folder).toBe('all');
    expect(result.q).toBe('is:unread');
  });

  it('keeps draft folder search on drafts.list but uses mail for all folders', () => {
    const routeResolved = resolveMailRouteFilter('draft', new Map());
    const inDrafts = expectValidSearchListRequest(resolveSearchListRequest({
      scope: 'folder',
      query: 'menu',
      filters: [],
      routeResolved,
      baseFilters: {},
    }));
    expect(inDrafts.useDraftsList).toBe(true);
    expect(inDrafts.folder).toBe('draft');

    const allMail = expectValidSearchListRequest(resolveSearchListRequest({
      scope: 'all',
      query: 'menu',
      filters: [],
      routeResolved,
      baseFilters: {},
    }));
    expect(allMail.useDraftsList).toBe(false);
    expect(allMail.folder).toBe('all');
  });

  it('omits header chips from the initial this-folder Drafts request', () => {
    const result = expectValidSearchListRequest(
      resolveSearchListRequest({
        scope: 'folder',
        query: 'menu',
        filters: [unreadFilter()],
        routeResolved: resolveMailRouteFilter('draft', new Map()),
        baseFilters: {},
      }),
    );

    expect(result).toMatchObject({
      effectiveQuery: 'menu',
      q: 'menu',
      filters: {},
      useDraftsList: true,
    });
  });

  it('keeps typed unsupported Drafts operators while omitting header chips', () => {
    const result = expectValidSearchListRequest(
      resolveSearchListRequest({
        scope: 'folder',
        query: 'from:sender',
        filters: [unreadFilter()],
        routeResolved: resolveMailRouteFilter('draft', new Map()),
        baseFilters: {},
      }),
    );

    expect(result).toMatchObject({
      effectiveQuery: 'from:sender',
      q: 'from:sender',
      filters: {},
      useDraftsList: true,
    });
  });
});
