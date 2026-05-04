import type { CenturionMailCategory } from '@/lib/domain/mail-thread';

export type DemoMailFolderId =
  | 'internal'
  | 'individual'
  | 'group'
  | 'travel-agents'
  | 'urgent'
  | 'spam';

const CENTURION_CATEGORY_SLUGS = new Set<string>(['internal', 'individual', 'group', 'travel-agents']);

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
   * Internal mail: blue conveys clarity, professionalism, and reliability.
   */
  internal: {
    bg: '#DBEAFE',
    text: '#1E3A8A',
    darkBg: '#1E3A8A',
    darkText: '#DBEAFE',
  },
  /**
   * Individual room bookings: green suggests trust, calm handling, and action-ready support.
   */
  individual: {
    bg: '#DCFCE7',
    text: '#166534',
    darkBg: '#14532D',
    darkText: '#DCFCE7',
  },
  /**
   * Group bookings: orange suggests activity, coordination, and urgency for events.
   */
  group: {
    bg: '#FFEDD5',
    text: '#9A3412',
    darkBg: '#7C2D12',
    darkText: '#FED7AA',
  },
  /**
   * Travel agents: purple implies partnership, exploration, and strategic coordination.
   */
  'travel-agents': {
    bg: '#EDE9FE',
    text: '#4C1D95',
    darkBg: '#5B21B6',
    darkText: '#EDE9FE',
  },
};

export function getCenturionCategoryColorStyle(slug: CenturionMailCategory): CenturionCategoryColorStyle {
  return CENTURION_CATEGORY_COLOR_STYLES[slug];
}

/** Plain sidebar row for demo Centurion folders (no React / icons). */
export type DemoMailSidebarNavDescriptor = {
  id: DemoMailFolderId;
  title: string;
  subtitle: string;
  /** Segment after `/mail/`. */
  pathSegment: string;
};

/** Ordered demo mail nav rows (excludes spam; urgent first). */
export function listDemoMailSidebarNavDescriptors(): DemoMailSidebarNavDescriptor[] {
  return DEMO_MAIL_FOLDER_DEFINITIONS.filter((folder) => folder.id !== 'spam')
    .sort((a, b) => (a.id === 'urgent' ? -1 : b.id === 'urgent' ? 1 : 0))
    .map((folder) => ({
      id: folder.id,
      title: folder.title,
      subtitle: folder.subtitle,
      pathSegment: folder.id,
    }));
}

export type DemoMailFolderSidebarChrome = {
  className?: string;
  style?: Record<string, string>;
};

/** Theme tokens for sidebar row; Centurion categories only. */
export function getDemoMailFolderSidebarChrome(folderId: DemoMailFolderId): DemoMailFolderSidebarChrome {
  if (!isCenturionMailCategorySlug(folderId)) {
    return {};
  }

  const palette = getCenturionCategoryColorStyle(folderId);
  return {
    style: {
      '--centurion-sidebar-bg': palette.bg,
      '--centurion-sidebar-text': palette.text,
      '--centurion-sidebar-bg-dark': palette.darkBg,
      '--centurion-sidebar-text-dark': palette.darkText,
    },
    className:
      'bg-[var(--centurion-sidebar-bg)] text-[var(--centurion-sidebar-text)] dark:bg-[var(--centurion-sidebar-bg-dark)] dark:text-[var(--centurion-sidebar-text-dark)]',
  };
}

/** Demo-only mail slices (URLs under /mail/:folder). Order = sidebar order. */
export const DEMO_MAIL_FOLDER_DEFINITIONS: DemoMailFolderDefinition[] = [
  {
    id: 'internal',
    title: 'Internal Mail',
    subtitle: 'HR & team',
    aliases: ['internal-mail', 'hr'],
  },
  {
    id: 'individual',
    title: 'Individual Room Bookings',
    subtitle: 'Guest & room requests',
    aliases: ['individual-room-bookings'],
  },
  {
    id: 'group',
    title: 'Group Bookings',
    subtitle: 'Blocks & events',
    aliases: ['group-bookings'],
  },
  {
    id: 'travel-agents',
    title: 'Travel Agents',
    subtitle: 'Agency & partner mail',
    aliases: ['travel-agent'],
  },
  {
    id: 'urgent',
    title: 'Urgent',
    subtitle: 'Flagged time-sensitive',
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
