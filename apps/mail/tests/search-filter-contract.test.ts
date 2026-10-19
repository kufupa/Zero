import { describe, expect, it } from 'vitest';
import {
  getHotelFolderPresentation,
  getHotelPillColorStyle,
} from '@/lib/mail/hotel-folder-presentation';
import {
  buildListThreadsInput,
  buildReservedSpamLabelIdSet,
  categoryColorNavTheme,
  isArchiveLikeMailFolder,
  isReservedSpamScopedLabelId,
  isUserFolderRouteParam,
  mergeCategoryIds,
  mergeLabelIds,
  resolveMailRouteFilter,
  toggleCategoryChip,
} from '../lib/mail/route-filter';
import { canUseNaturalLanguageSearch, PILOT_CAPABILITIES } from '../lib/pilot/capabilities';

describe('mail route filter contract', () => {
  it('maps hotel category slug to structured category filter', () => {
    const result = resolveMailRouteFilter(
      'at-risk',
      new Map([['at-risk', 'cat-at-risk']]),
    );
    expect(result).toEqual({
      folder: 'inbox',
      filters: { categoryIds: ['cat-at-risk'] },
    });
  });

  it('does not AND hotel category membership onto workflow folder routes', () => {
    const categories = new Map([
      ['new-bookings', 'cat-new-bookings'],
      ['groups-events', 'cat-groups-events'],
      ['quotes', 'cat-quotes'],
      ['at-risk', 'cat-at-risk'],
    ]);
    expect(resolveMailRouteFilter('new-bookings', categories)).toEqual({
      folder: 'inbox',
      filters: {},
    });
    expect(resolveMailRouteFilter('groups-events', categories)).toEqual({
      folder: 'inbox',
      filters: {},
    });
    expect(resolveMailRouteFilter('quotes', categories)).toEqual({
      folder: 'inbox',
      filters: {},
    });
    expect(resolveMailRouteFilter('at-risk', categories)).toEqual({
      folder: 'inbox',
      filters: { categoryIds: ['cat-at-risk'] },
    });
  });

  it('keeps system folders as folders', () => {
    const result = resolveMailRouteFilter('spam', new Map([['spam', 'cat-spam']]));
    expect(result).toEqual({ folder: 'spam', filters: {} });
  });

  it('maps known user label UUID to archive + labelIds', () => {
    const labelId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    expect(resolveMailRouteFilter(labelId, new Map(), new Set([labelId]))).toEqual({
      folder: 'archive',
      filters: { labelIds: [labelId] },
    });
    // system folder still wins when path is a system slug
    expect(resolveMailRouteFilter('inbox', new Map(), new Set([labelId]))).toEqual({
      folder: 'inbox',
      filters: {},
    });
  });

  it('UUID-shaped path uses archive+labelIds before labelIdSet hydrates', () => {
    const unknownId = '00000000-0000-4000-8000-000000000099';
    expect(resolveMailRouteFilter(unknownId, new Map(), new Set())).toEqual({
      folder: 'archive',
      filters: { labelIds: [unknownId] },
    });
    expect(resolveMailRouteFilter('not-a-folder', new Map())).toEqual({
      folder: 'inbox',
      filters: {},
    });
    expect(
      resolveMailRouteFilter(unknownId, new Map(), new Set(['other-label-id'])),
    ).toEqual({
      folder: 'archive',
      filters: { labelIds: [unknownId] },
    });
  });

  it('maps reserved Quarantine label UUID to spam + labelIds', () => {
    const quarantineId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const reserved = new Set([quarantineId]);
    expect(resolveMailRouteFilter(quarantineId, new Map(), new Set([quarantineId]), reserved)).toEqual({
      folder: 'spam',
      filters: { labelIds: [quarantineId] },
    });
    expect(isArchiveLikeMailFolder(quarantineId, reserved)).toBe(false);
    expect(isReservedSpamScopedLabelId(quarantineId, reserved)).toBe(true);
  });

  it('buildReservedSpamLabelIdSet resolves Quarantine name to id', () => {
    const quarantineId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const reserved = buildReservedSpamLabelIdSet([
      { id: quarantineId, name: 'Quarantine' },
      { id: 'other-id', name: 'Follow up' },
    ]);
    expect(reserved.has(quarantineId.toLowerCase())).toBe(true);
    expect(reserved.has('other-id')).toBe(false);
  });

  it('isArchiveLikeMailFolder covers archive + My folders UUID routes only', () => {
    expect(isArchiveLikeMailFolder('archive')).toBe(true);
    expect(isArchiveLikeMailFolder('archived')).toBe(true);
    expect(isArchiveLikeMailFolder('00000000-0000-4000-8000-000000000099')).toBe(true);
    expect(isArchiveLikeMailFolder('inbox')).toBe(false);
    expect(isArchiveLikeMailFolder('new-bookings')).toBe(false);
    expect(isUserFolderRouteParam('inbox')).toBe(false);
    expect(isUserFolderRouteParam('00000000-0000-4000-8000-000000000099')).toBe(true);
  });

  it('category slug still wins over labelIdSet miss', () => {
    const result = resolveMailRouteFilter(
      'at-risk',
      new Map([['at-risk', 'cat-at-risk']]),
      new Set(['some-label']),
    );
    expect(result).toEqual({
      folder: 'inbox',
      filters: { categoryIds: ['cat-at-risk'] },
    });
  });

  it('hotel chip selection yields categoryIds not labelIds', () => {
    const nextIds = toggleCategoryChip([], 'cat-new-bookings');
    expect(nextIds).toEqual(['cat-new-bookings']);
    expect(toggleCategoryChip(nextIds, 'cat-new-bookings')).toEqual([]);

    const input = buildListThreadsInput({ categoryIds: ['cat-new-bookings'], labels: [] });
    expect(input).toEqual({
      filters: { categoryIds: ['cat-new-bookings'] },
      labelIds: [],
    });
    expect(input.labelIds).toEqual([]);
    expect(input.filters.categoryIds).not.toEqual(input.labelIds);
  });

  it('hotel chip display uses presentation title for managed slug', () => {
    expect(getHotelFolderPresentation('new-bookings')?.title).toBe('New Bookings');
    expect(getHotelPillColorStyle('new-bookings').bg).toBe('#DCFCE7');
  });

  it('merges route + query categoryIds and applies color theme', () => {
    expect(mergeCategoryIds(['cat-route'], ['cat-query', 'cat-route'])).toEqual([
      'cat-route',
      'cat-query',
    ]);
    const theme = categoryColorNavTheme('#1E3A8A');
    expect(theme.className).toContain('bg-[var(--centurion-sidebar-bg)]');
    expect((theme.style as Record<string, string>)['--centurion-sidebar-bg']).toBe('#1E3A8A');
    expect(categoryColorNavTheme(null)).toEqual({});
  });

  it('merges route + search labelIds with dedupe', () => {
    expect(mergeLabelIds(['label-route'], ['label-search', 'label-route'])).toEqual([
      'label-route',
      'label-search',
    ]);
    expect(mergeLabelIds(undefined, ['a'])).toEqual(['a']);
  });
});

describe('pilot search capability gates', () => {
  it('enables Gmail grammar search while AI natural language stays off', () => {
    expect(canUseNaturalLanguageSearch()).toBe(false);
    expect(PILOT_CAPABILITIES.gmailSearchGrammar).toBe(true);
  });
});
