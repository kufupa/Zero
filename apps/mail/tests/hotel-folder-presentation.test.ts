import {
  buildCategoryIdToSlugMap,
  getHotelFolderNavTheme,
  getHotelFolderPresentation,
  getHotelPillColorStyle,
  HOTEL_WORKFLOW_PRIMARY_SLUGS,
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

const expectedWorkflowPalettes: Record<
  (typeof HOTEL_WORKFLOW_PRIMARY_SLUGS)[number],
  ReturnType<typeof getHotelPillColorStyle>
> = {
  bookings: { bg: '#DBEAFE', text: '#1E3A8A', darkBg: '#1E3A8A', darkText: '#DBEAFE' },
  'groups-events': {
    bg: '#FFEDD5',
    text: '#9A3412',
    darkBg: '#7C2D12',
    darkText: '#FED7AA',
  },
  'manage-stay': { bg: '#CCFBF1', text: '#115E59', darkBg: '#134E4A', darkText: '#99F6E4' },
  'confirm-reconcile': {
    bg: '#CFFAFE',
    text: '#155E75',
    darkBg: '#164E63',
    darkText: '#A5F3FC',
  },
  'money-billing': { bg: '#DCFCE7', text: '#166534', darkBg: '#14532D', darkText: '#BBF7D0' },
  'documents-delivery': {
    bg: '#E0E7FF',
    text: '#3730A3',
    darkBg: '#312E81',
    darkText: '#C7D2FE',
  },
  'exceptions-recovery': {
    bg: '#FFE4E6',
    text: '#9F1239',
    darkBg: '#881337',
    darkText: '#FECDD3',
  },
  'guest-experience': {
    bg: '#FCE7F3',
    text: '#9D174D',
    darkBg: '#831843',
    darkText: '#FBCFE8',
  },
  'internal-partner': {
    bg: '#EDE9FE',
    text: '#5B21B6',
    darkBg: '#4C1D95',
    darkText: '#DDD6FE',
  },
  'automated-channel': {
    bg: '#F1F5F9',
    text: '#334155',
    darkBg: '#1E293B',
    darkText: '#CBD5E1',
  },
  'unknown-review': {
    bg: '#FEF3C7',
    text: '#92400E',
    darkBg: '#78350F',
    darkText: '#FDE68A',
  },
};

const expectedLegacyPalettes: Record<
  'at-risk' | 'new-bookings' | 'ops',
  ReturnType<typeof getHotelPillColorStyle>
> = {
  'at-risk': { bg: '#FEF3C7', text: '#92400E', darkBg: '#78350F', darkText: '#FEF3C7' },
  'new-bookings': { bg: '#DCFCE7', text: '#166534', darkBg: '#14532D', darkText: '#DCFCE7' },
  ops: { bg: '#DBEAFE', text: '#1E3A8A', darkBg: '#1E3A8A', darkText: '#DBEAFE' },
};

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

  it('assigns a distinct semantic pastel palette to every workflow folder', () => {
    for (const slug of HOTEL_WORKFLOW_PRIMARY_SLUGS) {
      const palette = expectedWorkflowPalettes[slug];
      expect(getHotelPillColorStyle(slug)).toEqual(palette);
      expect(getHotelFolderNavTheme(slug).style).toEqual({
        '--centurion-sidebar-bg': palette.bg,
        '--centurion-sidebar-text': palette.text,
        '--centurion-sidebar-bg-dark': palette.darkBg,
        '--centurion-sidebar-text-dark': palette.darkText,
      });
    }
    expect(getHotelPillColorStyle('urgent')).toEqual({
      bg: '#FEE2E2',
      text: '#991B1B',
      darkBg: '#7F1D1D',
      darkText: '#FEE2E2',
    });
    expect(getHotelFolderNavTheme('urgent').style).toEqual({
      '--centurion-sidebar-bg': '#FEE2E2',
      '--centurion-sidebar-text': '#991B1B',
      '--centurion-sidebar-bg-dark': '#7F1D1D',
      '--centurion-sidebar-text-dark': '#FEE2E2',
    });
  });

  it('preserves the exact palette contract for legacy Centurion folders', () => {
    for (const [slug, palette] of Object.entries(expectedLegacyPalettes)) {
      expect(getHotelPillColorStyle(slug as keyof typeof expectedLegacyPalettes)).toEqual(palette);
    }
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
    expect(items.find((item) => item.id === 'bookings')?.style).toEqual(
      getHotelFolderNavTheme('bookings').style,
    );
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
    expect(items.find((item) => item.id === 'bookings')?.style).toEqual(
      getHotelFolderNavTheme('bookings').style,
    );
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
    expect(JSON.stringify(palette.style)).toContain('#FEF3C7');
  });
});
