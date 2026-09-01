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
import {
  buildDemoMailFolderNavItems,
  buildLiveCategoryNavItems,
  isWorkflowNavV6Enabled,
} from '@/config/navigation';
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

describe('workflow nav flag', () => {
  it('keeps legacy four primaries plus urgent when flag is off', () => {
    expect(buildDemoMailFolderNavItems(false).map((item) => item.id)).toEqual([
      'urgent',
      'at-risk',
      'new-bookings',
      'groups-events',
      'ops',
    ]);
  });

  it('uses exclusive workflow primaries plus urgent when flag is on', () => {
    const items = buildDemoMailFolderNavItems(true);
    expect(items.map((item) => item.id)).toEqual([
      'urgent',
      'bookings',
      'groups-events',
      'manage-stay',
      'confirm-reconcile',
      'money-billing',
      'documents-delivery',
      'exceptions-recovery',
      'guest-experience',
      'internal-partner',
      'automated-channel',
      'unknown-review',
    ]);
    expect(items.map((item) => item.id)).not.toContain('spam');
    expect(items.find((item) => item.id === 'unknown-review')?.className).toContain(
      '--centurion-sidebar-bg',
    );
  });

  it('filters live categories to current flag set and keeps spam out of Folders', () => {
    const categories = [
      { slug: 'spam', name: 'Spam', sortOrder: 1 },
      { slug: 'at-risk', name: 'At risk', sortOrder: 20 },
      { slug: 'groups-events', name: 'Groups & Events', sortOrder: 25 },
      { slug: 'urgent', name: 'Urgent', sortOrder: 10 },
      { slug: 'bookings', name: 'Bookings', sortOrder: 30 },
      { slug: 'unknown-review', name: 'Unknown', sortOrder: 40 },
    ];
    expect(buildLiveCategoryNavItems(categories, false).map((item) => item.id)).toEqual([
      'urgent',
      'at-risk',
      'groups-events',
    ]);
    expect(buildLiveCategoryNavItems(categories, true).map((item) => item.id)).toEqual([
      'urgent',
      'groups-events',
      'bookings',
      'unknown-review',
    ]);
  });

  it('parses nav flag without coupling durable triage flag', () => {
    expect(isWorkflowNavV6Enabled({ VITE_WORKFLOW_NAV_V6: undefined })).toBe(false);
    expect(isWorkflowNavV6Enabled({ VITE_WORKFLOW_NAV_V6: '1' })).toBe(true);
    expect(isWorkflowNavV6Enabled({ VITE_WORKFLOW_NAV_V6: 'true' })).toBe(true);
    expect(isWorkflowNavV6Enabled({ VITE_WORKFLOW_NAV_V6: '0' })).toBe(false);
  });
});

describe('workflow category pills', () => {
  it('shows primary workflow pill while viewing Urgent route', () => {
    expect(
      shouldShowHotelCategoryPill({
        routeFolder: 'urgent',
        pillSlug: 'unknown-review',
      }),
    ).toBe(true);
    const palette = getHotelFolderNavTheme('unknown-review');
    expect(palette.className).toContain('--centurion-sidebar-bg');
    expect(JSON.stringify(palette.style)).toContain('#E2E8F0');
  });
});
