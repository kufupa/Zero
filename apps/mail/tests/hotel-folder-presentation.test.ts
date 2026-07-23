import { describe, expect, it } from 'vitest';
import {
  buildCategoryIdToSlugMap,
  getHotelFolderNavTheme,
  getHotelFolderPresentation,
  isHotelManagedCategorySlug,
  resolveThreadCategoryPresentation,
  shouldShowHotelCategoryPill,
} from '@/lib/mail/hotel-folder-presentation';

describe('hotel-folder-presentation', () => {
  it('locks managed slugs to AI taxonomy', () => {
    expect(isHotelManagedCategorySlug('individual')).toBe(true);
    expect(isHotelManagedCategorySlug('urgent')).toBe(true);
    expect(isHotelManagedCategorySlug('spam')).toBe(false);
  });

  it('returns demo-style title and subtitle for managed slugs', () => {
    expect(getHotelFolderPresentation('individual')).toEqual({
      title: 'Individual Room Bookings',
      subtitle: 'Guest & room requests',
    });
    expect(getHotelFolderPresentation('unknown-custom')).toBeNull();
  });

  it('nav theme for managed slug uses Centurion pastel CSS vars not solid hex', () => {
    const theme = getHotelFolderNavTheme('individual');
    expect(theme.className).toContain('--centurion-sidebar-bg');
    expect(JSON.stringify(theme.style)).toContain('#DCFCE7');
  });

  it('urgent nav theme includes right-edge stripe class', () => {
    const theme = getHotelFolderNavTheme('urgent');
    expect(theme.className).toContain('after:bg-red-500');
  });

  it('resolve: primary + urgent → primary pillSlug + isUrgent', () => {
    const idToSlug = buildCategoryIdToSlugMap([
      { id: 'c-ind', slug: 'individual' },
      { id: 'c-urg', slug: 'urgent' },
    ]);
    const resolved = resolveThreadCategoryPresentation(['c-ind', 'c-urg'], idToSlug);
    expect(resolved).toEqual({
      primarySlug: 'individual',
      isUrgent: true,
      pillSlug: 'individual',
    });
  });

  it('resolve: urgent only → pillSlug urgent', () => {
    const idToSlug = buildCategoryIdToSlugMap([{ id: 'c-urg', slug: 'urgent' }]);
    expect(resolveThreadCategoryPresentation(['c-urg'], idToSlug).pillSlug).toBe('urgent');
  });

  it('resolve: empty or unmapped → null pill', () => {
    const idToSlug = buildCategoryIdToSlugMap([{ id: 'c-ind', slug: 'individual' }]);
    expect(resolveThreadCategoryPresentation([], idToSlug).pillSlug).toBeNull();
    expect(resolveThreadCategoryPresentation(['missing'], idToSlug).pillSlug).toBeNull();
  });

  it('hides pill when route already is that category', () => {
    expect(
      shouldShowHotelCategoryPill({ routeFolder: 'individual', pillSlug: 'individual' }),
    ).toBe(false);
    expect(shouldShowHotelCategoryPill({ routeFolder: 'inbox', pillSlug: 'individual' })).toBe(
      true,
    );
    expect(shouldShowHotelCategoryPill({ routeFolder: 'urgent', pillSlug: 'urgent' })).toBe(false);
  });
});
