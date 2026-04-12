import type { CenturionMailCategory } from '../../../server/src/lib/driver/types';

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
