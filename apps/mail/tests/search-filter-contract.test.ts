import { describe, expect, it } from 'vitest';
import {
  getHotelFolderPresentation,
  getHotelPillColorStyle,
} from '@/lib/mail/hotel-folder-presentation';
import {
  buildListThreadsInput,
  categoryColorNavTheme,
  mergeCategoryIds,
  resolveMailRouteFilter,
  toggleCategoryChip,
} from '../lib/mail/route-filter';
import { canUseNaturalLanguageSearch, PILOT_CAPABILITIES } from '../lib/pilot/capabilities';

describe('mail route filter contract', () => {
  it('maps hotel category slug to structured category filter', () => {
    const result = resolveMailRouteFilter(
      'travel-agents',
      new Map([['travel-agents', 'cat-travel']]),
    );
    expect(result).toEqual({
      folder: 'inbox',
      filters: { categoryIds: ['cat-travel'] },
    });
  });

  it('keeps system folders as folders', () => {
    const result = resolveMailRouteFilter('spam', new Map([['spam', 'cat-spam']]));
    expect(result).toEqual({ folder: 'spam', filters: {} });
  });

  it('hotel chip selection yields categoryIds not labelIds', () => {
    const nextIds = toggleCategoryChip([], 'cat-travel');
    expect(nextIds).toEqual(['cat-travel']);
    expect(toggleCategoryChip(nextIds, 'cat-travel')).toEqual([]);

    const input = buildListThreadsInput({ categoryIds: ['cat-travel'], labels: [] });
    expect(input).toEqual({
      filters: { categoryIds: ['cat-travel'] },
      labelIds: [],
    });
    expect(input.labelIds).toEqual([]);
    expect(input.filters.categoryIds).not.toEqual(input.labelIds);
  });

  it('hotel chip display uses presentation title for managed slug', () => {
    expect(getHotelFolderPresentation('travel-agents')?.title).toBe('Travel Agents');
    expect(getHotelPillColorStyle('travel-agents').bg).toBe('#EDE9FE');
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
});

describe('pilot search capability gates', () => {
  it('enables Gmail grammar search while AI natural language stays off', () => {
    expect(canUseNaturalLanguageSearch()).toBe(false);
    expect(PILOT_CAPABILITIES.gmailSearchGrammar).toBe(true);
  });
});
