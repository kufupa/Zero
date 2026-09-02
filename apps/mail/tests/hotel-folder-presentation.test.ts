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
  injectLiveCategoryNavSection,
  navigationConfig,
} from '@/config/navigation';
import { describe, expect, it } from 'vitest';

const expectedWorkflowIds = [
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
];

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
  it('uses the fixed workflow order regardless of API sortOrder values', () => {
    const shuffledCategories = expectedWorkflowIds.map((slug, index) => ({
      slug,
      name: slug,
      sortOrder: expectedWorkflowIds.length - index,
      ...(slug === 'urgent' ? { color: '#2563eb' } : {}),
    }));

    const items = buildLiveCategoryNavItems(shuffledCategories);

    expect(items.map((item) => item.id)).toEqual(expectedWorkflowIds);
    expect(items.find((item) => item.id === 'urgent')?.className).toContain('after:bg-red-500');
    expect(items.find((item) => item.id === 'urgent')?.title).toBe('Urgent');
  });

  it('excludes custom and non-workflow live categories', () => {
    const categories = [
      { slug: 'at-risk', name: 'At risk', sortOrder: 1 },
      { slug: 'new-bookings', name: 'New Bookings', sortOrder: 2 },
      { slug: 'vip-custom', name: 'VIP Desk', sortOrder: 3 },
      { slug: 'spam', name: 'Spam', sortOrder: 4 },
    ];
    const items = buildLiveCategoryNavItems(categories);

    expect(items).toEqual([]);
  });

  it('injects live folders between Core and Management without changing static config', () => {
    const fixtureCategories = expectedWorkflowIds.map((slug, index) => ({
      slug,
      name: slug,
      sortOrder: index + 1,
    }));
    fixtureCategories.push({ slug: 'spam', name: 'Spam', sortOrder: 0 });

    expect(navigationConfig.mail.sections.map((section) => section.title)).not.toContain('Folders');

    const sections = injectLiveCategoryNavSection(
      navigationConfig.mail.sections,
      fixtureCategories,
    );

    expect(sections.map((section) => section.title)).toEqual(['Core', 'Folders', 'Management']);
    expect(sections[0]?.items.map((item) => item.id)).toEqual(['inbox', 'drafts', 'sent']);
    expect(sections[1]?.items.map((item) => item.id)).toEqual(expectedWorkflowIds);
    expect(sections[1]?.items.map((item) => item.id)).not.toContain('spam');
    expect(sections[2]?.items.map((item) => item.id)).toEqual([
      'archive',
      'snoozed',
      'trash',
      'spam',
    ]);
  });
});

describe('buildDemoMailFolderNavItems', () => {
  it('always exposes workflow folders in canonical order without spam', () => {
    const items = buildDemoMailFolderNavItems();

    expect(items.map((item) => item.id)).toEqual(expectedWorkflowIds);
    expect(items.map((item) => item.id)).not.toContain('spam');
    expect(items.find((item) => item.id === 'urgent')?.className).toContain('after:bg-red-500');
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
