import {
  getDemoMailFolderDefinition,
  getCenturionCategoryColorStyle,
  isCenturionMailCategorySlug,
  normalizeDemoMailFolderSlug,
  type CenturionCategoryColorStyle,
} from '@/lib/demo/folder-map';
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

/**
 * Locked to apps/server-pilot/src/ai/categories.ts
 * AI_WORKFLOW_PRIMARY_SLUGS / AI_OVERLAY_CATEGORY_SLUGS — do not drift.
 */
export const HOTEL_LEGACY_PRIMARY_CATEGORY_SLUGS = [
  'at-risk',
  'new-bookings',
  'groups-events',
  'ops',
] as const;

export const HOTEL_WORKFLOW_PRIMARY_SLUGS = [
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
] as const;

/** Legacy + workflow slugs remain readable until durable migration completes. */
export const HOTEL_PRIMARY_CATEGORY_SLUGS = [
  ...HOTEL_WORKFLOW_PRIMARY_SLUGS,
  'at-risk',
  'new-bookings',
  'ops',
] as const;

export const HOTEL_OVERLAY_CATEGORY_SLUGS = ['urgent'] as const;

export const HOTEL_MANAGED_CATEGORY_SLUGS = [
  ...HOTEL_PRIMARY_CATEGORY_SLUGS,
  ...HOTEL_OVERLAY_CATEGORY_SLUGS,
] as const;

export type HotelPrimarySlug = (typeof HOTEL_PRIMARY_CATEGORY_SLUGS)[number];
export type HotelWorkflowPrimarySlug = (typeof HOTEL_WORKFLOW_PRIMARY_SLUGS)[number];
export type HotelOverlaySlug = (typeof HOTEL_OVERLAY_CATEGORY_SLUGS)[number];
export type HotelManagedSlug = (typeof HOTEL_MANAGED_CATEGORY_SLUGS)[number];

const PRIMARY_SET = new Set<string>(HOTEL_PRIMARY_CATEGORY_SLUGS);
const WORKFLOW_PRIMARY_SET = new Set<string>(HOTEL_WORKFLOW_PRIMARY_SLUGS);
const MANAGED_SET = new Set<string>(HOTEL_MANAGED_CATEGORY_SLUGS);

const URGENT_COLOR_STYLE: CenturionCategoryColorStyle = {
  bg: '#FEE2E2',
  text: '#991B1B',
  darkBg: '#7F1D1D',
  darkText: '#FEE2E2',
};

/**
 * Frontend-owned semantic presentation for the canonical workflow folders.
 *
 * These soft backgrounds keep the sidebar scannable while the paired dark
 * foregrounds preserve readable contrast in both themes. Do not replace this
 * with server seed colors: those are taxonomy data, while these tokens are a
 * stable UI contract.
 */
const WORKFLOW_COLOR_STYLES: Record<HotelWorkflowPrimarySlug, CenturionCategoryColorStyle> = {
  bookings: {
    bg: '#DBEAFE',
    text: '#1E3A8A',
    darkBg: '#1E3A8A',
    darkText: '#DBEAFE',
  },
  'groups-events': {
    bg: '#FFEDD5',
    text: '#9A3412',
    darkBg: '#7C2D12',
    darkText: '#FED7AA',
  },
  'manage-stay': {
    bg: '#CCFBF1',
    text: '#115E59',
    darkBg: '#134E4A',
    darkText: '#99F6E4',
  },
  'confirm-reconcile': {
    bg: '#CFFAFE',
    text: '#155E75',
    darkBg: '#164E63',
    darkText: '#A5F3FC',
  },
  'money-billing': {
    bg: '#DCFCE7',
    text: '#166534',
    darkBg: '#14532D',
    darkText: '#BBF7D0',
  },
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

export function isHotelManagedCategorySlug(slug: string): slug is HotelManagedSlug {
  return MANAGED_SET.has(slug);
}

export function isHotelPrimaryCategorySlug(slug: string): slug is HotelPrimarySlug {
  return PRIMARY_SET.has(slug);
}

export function isHotelWorkflowPrimarySlug(slug: string): slug is HotelWorkflowPrimarySlug {
  return WORKFLOW_PRIMARY_SET.has(slug);
}

export function getHotelFolderPresentation(
  slug: string,
): { title: string; subtitle: string } | null {
  if (!isHotelManagedCategorySlug(slug)) return null;
  const def = getDemoMailFolderDefinition(slug);
  if (!def) return null;
  return { title: def.title, subtitle: def.subtitle };
}

export function getHotelPillColorStyle(slug: HotelManagedSlug): CenturionCategoryColorStyle {
  if (slug === 'urgent') return URGENT_COLOR_STYLE;
  if (isHotelWorkflowPrimarySlug(slug)) return WORKFLOW_COLOR_STYLES[slug];
  if (!isCenturionMailCategorySlug(slug)) return WORKFLOW_COLOR_STYLES['automated-channel'];
  return getCenturionCategoryColorStyle(slug);
}

export function getHotelFolderNavTheme(slug: string): {
  style?: CSSProperties;
  className?: string;
} {
  if (!isHotelManagedCategorySlug(slug)) return {};

  const palette = getHotelPillColorStyle(slug);
  const theme = {
    style: {
      '--centurion-sidebar-bg': palette.bg,
      '--centurion-sidebar-text': palette.text,
      '--centurion-sidebar-bg-dark': palette.darkBg,
      '--centurion-sidebar-text-dark': palette.darkText,
    } as CSSProperties,
    className:
      'bg-[var(--centurion-sidebar-bg)] text-[var(--centurion-sidebar-text)] dark:bg-[var(--centurion-sidebar-bg-dark)] dark:text-[var(--centurion-sidebar-text-dark)]',
  };

  if (slug === 'urgent') {
    return {
      ...theme,
      className: cn(
        theme.className,
        "relative after:absolute after:inset-y-1.5 after:right-0 after:w-1 after:rounded-l-sm after:bg-red-500/90 after:content-['']",
      ),
    };
  }
  return theme;
}

export function buildCategoryIdToSlugMap(
  categories: Array<{ id: string; slug?: string | null }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const category of categories) {
    if (category.slug) map.set(category.id, category.slug);
  }
  return map;
}

export function resolveThreadCategoryPresentation(
  categoryIds: string[],
  idToSlug: Map<string, string>,
): {
  primarySlug: HotelPrimarySlug | null;
  isUrgent: boolean;
  pillSlug: HotelManagedSlug | null;
} {
  const slugs = categoryIds
    .map((id) => idToSlug.get(id))
    .filter((slug): slug is string => Boolean(slug));

  let primarySlug: HotelPrimarySlug | null = null;
  let isUrgent = false;

  for (const slug of slugs) {
    if (slug === 'urgent') isUrgent = true;
    else if (!primarySlug && isHotelPrimaryCategorySlug(slug)) primarySlug = slug;
  }

  const pillSlug: HotelManagedSlug | null = primarySlug ?? (isUrgent ? 'urgent' : null);
  return { primarySlug, isUrgent, pillSlug };
}

export function shouldShowHotelCategoryPill(input: {
  routeFolder: string | undefined;
  pillSlug: HotelManagedSlug | null;
}): boolean {
  const { routeFolder, pillSlug } = input;
  if (!pillSlug) return false;
  const routeSlug = normalizeDemoMailFolderSlug(routeFolder);
  if (isHotelManagedCategorySlug(routeSlug) && routeSlug === pillSlug) return false;
  return true;
}
