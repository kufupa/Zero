import type { CSSProperties } from 'react';
import {
  DEMO_MAIL_FOLDER_DEFINITIONS,
  getCenturionCategoryColorStyle,
  isCenturionMailCategorySlug,
  normalizeDemoMailFolderSlug,
  type CenturionCategoryColorStyle,
} from '@/lib/demo/folder-map';
import { cn } from '@/lib/utils';

/**
 * Locked to apps/server-pilot/src/ai/categories.ts
 * AI_PRIMARY_CATEGORY_SLUGS / AI_OVERLAY_CATEGORY_SLUGS — do not drift.
 */
export const HOTEL_PRIMARY_CATEGORY_SLUGS = [
  'internal',
  'individual',
  'group',
  'travel-agents',
] as const;

export const HOTEL_OVERLAY_CATEGORY_SLUGS = ['urgent'] as const;

export const HOTEL_MANAGED_CATEGORY_SLUGS = [
  ...HOTEL_PRIMARY_CATEGORY_SLUGS,
  ...HOTEL_OVERLAY_CATEGORY_SLUGS,
] as const;

export type HotelPrimarySlug = (typeof HOTEL_PRIMARY_CATEGORY_SLUGS)[number];
export type HotelOverlaySlug = (typeof HOTEL_OVERLAY_CATEGORY_SLUGS)[number];
export type HotelManagedSlug = (typeof HOTEL_MANAGED_CATEGORY_SLUGS)[number];

const PRIMARY_SET = new Set<string>(HOTEL_PRIMARY_CATEGORY_SLUGS);
const MANAGED_SET = new Set<string>(HOTEL_MANAGED_CATEGORY_SLUGS);

const URGENT_COLOR_STYLE: CenturionCategoryColorStyle = {
  bg: '#FEE2E2',
  text: '#991B1B',
  darkBg: '#7F1D1D',
  darkText: '#FEE2E2',
};

export function isHotelManagedCategorySlug(slug: string): slug is HotelManagedSlug {
  return MANAGED_SET.has(slug);
}

export function isHotelPrimaryCategorySlug(slug: string): slug is HotelPrimarySlug {
  return PRIMARY_SET.has(slug);
}

export function getHotelFolderPresentation(
  slug: string,
): { title: string; subtitle: string } | null {
  if (!isHotelManagedCategorySlug(slug)) return null;
  const def = DEMO_MAIL_FOLDER_DEFINITIONS.find((d) => d.id === slug);
  if (!def) return null;
  return { title: def.title, subtitle: def.subtitle };
}

export function getHotelPillColorStyle(slug: HotelManagedSlug): CenturionCategoryColorStyle {
  if (slug === 'urgent') return URGENT_COLOR_STYLE;
  return getCenturionCategoryColorStyle(slug);
}

export function getHotelFolderNavTheme(slug: string): {
  style?: CSSProperties;
  className?: string;
} {
  if (!isHotelManagedCategorySlug(slug)) return {};

  if (slug === 'urgent') {
    const palette = URGENT_COLOR_STYLE;
    return {
      style: {
        '--centurion-sidebar-bg': palette.bg,
        '--centurion-sidebar-text': palette.text,
        '--centurion-sidebar-bg-dark': palette.darkBg,
        '--centurion-sidebar-text-dark': palette.darkText,
      } as CSSProperties,
      className: cn(
        'bg-[var(--centurion-sidebar-bg)] text-[var(--centurion-sidebar-text)] dark:bg-[var(--centurion-sidebar-bg-dark)] dark:text-[var(--centurion-sidebar-text-dark)]',
        "relative after:absolute after:inset-y-1.5 after:right-0 after:w-1 after:rounded-l-sm after:bg-red-500/90 after:content-['']",
      ),
    };
  }

  if (!isCenturionMailCategorySlug(slug)) return {};
  const palette = getCenturionCategoryColorStyle(slug);
  return {
    style: {
      '--centurion-sidebar-bg': palette.bg,
      '--centurion-sidebar-text': palette.text,
      '--centurion-sidebar-bg-dark': palette.darkBg,
      '--centurion-sidebar-text-dark': palette.darkText,
    } as CSSProperties,
    className:
      'bg-[var(--centurion-sidebar-bg)] text-[var(--centurion-sidebar-text)] dark:bg-[var(--centurion-sidebar-bg-dark)] dark:text-[var(--centurion-sidebar-text-dark)]',
  };
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
