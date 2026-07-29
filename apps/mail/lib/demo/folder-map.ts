import type { CenturionMailCategory } from '@zero/server/driver/types';

export type DemoMailFolderId =
  | 'at-risk'
  | 'new-bookings'
  | 'groups-events'
  | 'ops'
  | 'urgent'
  | 'spam';

const CENTURION_CATEGORY_SLUGS = new Set<string>([
  'at-risk',
  'new-bookings',
  'groups-events',
  'ops',
]);

export type DemoMailFolderDefinition = {
  id: DemoMailFolderId;
  title: string;
  subtitle: string;
  aliases: string[];
};

export type CenturionCategoryColorStyle = {
  bg: string;
  text: string;
  darkBg: string;
  darkText: string;
};

export const CENTURION_CATEGORY_COLOR_STYLES: Record<CenturionMailCategory, CenturionCategoryColorStyle> = {
  /**
   * At-risk mail: amber signals caution for cancel, SLA, and payment risk.
   */
  'at-risk': {
    bg: '#FEF3C7',
    text: '#92400E',
    darkBg: '#78350F',
    darkText: '#FEF3C7',
  },
  /**
   * New bookings: green suggests trust, calm handling, and action-ready support.
   */
  'new-bookings': {
    bg: '#DCFCE7',
    text: '#166534',
    darkBg: '#14532D',
    darkText: '#DCFCE7',
  },
  /**
   * Groups & events: orange suggests activity, coordination, and event urgency.
   */
  'groups-events': {
    bg: '#FFEDD5',
    text: '#9A3412',
    darkBg: '#7C2D12',
    darkText: '#FED7AA',
  },
  /**
   * Ops: blue conveys clarity, professionalism, and reliable handovers.
   */
  ops: {
    bg: '#DBEAFE',
    text: '#1E3A8A',
    darkBg: '#1E3A8A',
    darkText: '#DBEAFE',
  },
};

export function getCenturionCategoryColorStyle(slug: CenturionMailCategory): CenturionCategoryColorStyle {
  return CENTURION_CATEGORY_COLOR_STYLES[slug];
}

/** Demo-only mail slices (URLs under /mail/:folder). Order = sidebar order. */
export const DEMO_MAIL_FOLDER_DEFINITIONS: DemoMailFolderDefinition[] = [
  {
    id: 'at-risk',
    title: 'At risk',
    subtitle: 'Cancel/SLA/pay risk',
    aliases: ['at_risk', 'risk'],
  },
  {
    id: 'new-bookings',
    title: 'New Bookings',
    subtitle: 'Win or service a stay',
    aliases: ['new-booking', 'bookings'],
  },
  {
    id: 'groups-events',
    title: 'Groups & Events',
    subtitle: 'Multi-room / MICE',
    aliases: ['groups', 'events', 'mice'],
  },
  {
    id: 'ops',
    title: 'Ops',
    subtitle: 'Handovers & channel',
    aliases: ['operations', 'handover'],
  },
  {
    id: 'urgent',
    title: 'Urgent',
    subtitle: 'Same-day / SLA pin',
    aliases: [],
  },
  {
    id: 'spam',
    title: 'Spam',
    subtitle: 'Quarantined',
    aliases: [],
  },
];

const demoMailFolderBySlug = new Map<string, DemoMailFolderDefinition>(
  DEMO_MAIL_FOLDER_DEFINITIONS.flatMap((def) => [
    [def.id, def] as const,
    ...def.aliases.map((alias) => [alias.toLowerCase(), def] as const),
  ]),
);

/** Canonical slug for list adapter + query keys (post-alias). */
export function normalizeDemoMailFolderSlug(folder?: string): string {
  const raw = (folder ?? 'inbox').trim().toLowerCase() || 'inbox';
  const mapped = demoMailFolderBySlug.get(raw);
  if (mapped) return mapped.id;
  return raw;
}

export function isDemoMailFolderSlug(folder?: string): boolean {
  if (!folder) return false;
  return demoMailFolderBySlug.has(folder.trim().toLowerCase());
}

export function isCenturionMailCategorySlug(value: string): value is CenturionMailCategory {
  return CENTURION_CATEGORY_SLUGS.has(value);
}

export function getCenturionCategoryTitle(slug: CenturionMailCategory): string {
  const def = DEMO_MAIL_FOLDER_DEFINITIONS.find((d) => d.id === slug);
  return def?.title ?? slug;
}

/** Show category pill on aggregate routes; hide when already viewing that category folder. */
export function shouldShowCenturionCategoryPill(input: {
  routeFolder: string | undefined;
  category: CenturionMailCategory | undefined;
}): boolean {
  const { routeFolder, category } = input;
  if (!category || !CENTURION_CATEGORY_SLUGS.has(category)) return false;
  const routeSlug = normalizeDemoMailFolderSlug(routeFolder);
  if (CENTURION_CATEGORY_SLUGS.has(routeSlug) && routeSlug === category) return false;
  return true;
}
