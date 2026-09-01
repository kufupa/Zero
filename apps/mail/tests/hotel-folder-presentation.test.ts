import {
  buildCategoryIdToSlugMap,
  getHotelFolderNavTheme,
  getHotelFolderPresentation,
  isHotelManagedCategorySlug,
  resolveThreadCategoryPresentation,
  shouldShowHotelCategoryPill,
  isHotelPrimaryCategorySlug,
  isHotelWorkflowPrimarySlug,
} from '@/lib/mail/hotel-folder-presentation';
import { buildLiveCategoryNavItems } from '@/config/navigation';
import { describe, expect, it } from 'vitest';

describe('hotel-folder-presentation', () => {
  it('workflow folders are managed primaries and urgent stays overlay', () => {
    expect(isHotelWorkflowPrimarySlug('bookings')).toBe(true);
    expect(isHotelWorkflowPrimarySlug('groups-events')).toBe(true);
    expect(isHotelWorkflowPrimarySlug('unknown-review')).toBe(true);
    expect(isHotelPrimaryCategorySlug('urgent')).toBe(false);
    expect(isHotelWorkflowPrimarySlug('spam')).toBe(false);
    expect(getHotelFolderPresentation('bookings')).toEqual({
      title: 'Bookings',
      subtitle: 'New bookings + quotes',
    });
    expect(getHotelFolderPresentation('unknown-review')?.title).toMatch(/Unknown|Needs Review/i);
  });

  it('locks managed slugs to AI taxonomy', () => {
    expect(isHotelManagedCategorySlug('new-bookings')).toBe(true);
    expect(isHotelManagedCategorySlug('urgent')).toBe(true);
    expect(isHotelManagedCategorySlug('spam')).toBe(false);
  });

  it('returns demo-style title and subtitle for managed slugs', () => {
    expect(getHotelFolderPresentation('new-bookings')).toEqual({
      title: 'New Bookings',
      subtitle: expect.any(String),
    });
    expect(getHotelFolderPresentation('unknown-custom')).toBeNull();
  });

  it('nav theme for managed slug uses Centurion pastel CSS vars not solid hex', () => {
    const theme = getHotelFolderNavTheme('new-bookings');
    expect(theme.className).toContain('--centurion-sidebar-bg');
    expect(JSON.stringify(theme.style)).toContain('#DCFCE7');
  });

  it('urgent nav theme includes right-edge stripe class', () => {
    const theme = getHotelFolderNavTheme('urgent');
    expect(theme.className).toContain('after:bg-red-500');
  });

  it('resolve: primary + urgent → primary pillSlug + isUrgent', () => {
    const idToSlug = buildCategoryIdToSlugMap([
      { id: 'c-nb', slug: 'new-bookings' },
      { id: 'c-urg', slug: 'urgent' },
    ]);
    const resolved = resolveThreadCategoryPresentation(['c-nb', 'c-urg'], idToSlug);
    expect(resolved).toEqual({
      primarySlug: 'new-bookings',
      isUrgent: true,
      pillSlug: 'new-bookings',
    });
  });

  it('resolve: urgent only → pillSlug urgent', () => {
    const idToSlug = buildCategoryIdToSlugMap([{ id: 'c-urg', slug: 'urgent' }]);
    expect(resolveThreadCategoryPresentation(['c-urg'], idToSlug).pillSlug).toBe('urgent');
  });

  it('resolve: empty or unmapped → null pill', () => {
    const idToSlug = buildCategoryIdToSlugMap([{ id: 'c-nb', slug: 'new-bookings' }]);
    expect(resolveThreadCategoryPresentation([], idToSlug).pillSlug).toBeNull();
    expect(resolveThreadCategoryPresentation(['missing'], idToSlug).pillSlug).toBeNull();
  });

  it('hides pill when route already is that category', () => {
    expect(
      shouldShowHotelCategoryPill({ routeFolder: 'new-bookings', pillSlug: 'new-bookings' }),
    ).toBe(false);
    expect(shouldShowHotelCategoryPill({ routeFolder: 'inbox', pillSlug: 'new-bookings' })).toBe(
      true,
    );
    expect(shouldShowHotelCategoryPill({ routeFolder: 'urgent', pillSlug: 'urgent' })).toBe(false);
  });
});

describe('buildLiveCategoryNavItems theme precedence', () => {
  it('managed slug ignores seed hex and uses presentation title', () => {
    const items = buildLiveCategoryNavItems([
      {
        slug: 'new-bookings',
        name: 'New Bookings',
        color: '#2563eb',
        sortOrder: 110,
      },
    ]);
    expect(items[0]?.title).toBe('New Bookings');
    expect(items[0]?.subtitle).toBe('Win or service a stay');
    expect(items[0]?.className).toContain('--centurion-sidebar-bg');
    expect(JSON.stringify(items[0]?.style)).toContain('#DCFCE7');
    expect(JSON.stringify(items[0]?.style)).not.toContain('#2563eb');
  });

  it('unknown slug keeps API name and optional hex theme', () => {
    const items = buildLiveCategoryNavItems([
      { slug: 'vip-custom', name: 'VIP Desk', color: '#112233', sortOrder: 1 },
    ]);
    expect(items[0]?.title).toBe('VIP Desk');
    expect(items[0]?.subtitle).toBeUndefined();
  });
});
