export const AI_PRIMARY_CATEGORY_SLUGS = [
  'new-bookings',
  'groups-events',
  'at-risk',
  'ops',
] as const;

export const AI_OVERLAY_CATEGORY_SLUGS = ['urgent'] as const;

export const AI_MANAGED_CATEGORY_SLUGS = [
  ...AI_PRIMARY_CATEGORY_SLUGS,
  ...AI_OVERLAY_CATEGORY_SLUGS,
] as const;

export type AiPrimaryCategorySlug = (typeof AI_PRIMARY_CATEGORY_SLUGS)[number];
export type AiOverlayCategorySlug = (typeof AI_OVERLAY_CATEGORY_SLUGS)[number];
export type AiManagedCategorySlug = (typeof AI_MANAGED_CATEGORY_SLUGS)[number];

const AI_MANAGED_CATEGORY_SET = new Set<string>(AI_MANAGED_CATEGORY_SLUGS);

export function isAiManagedCategorySlug(slug: string): slug is AiManagedCategorySlug {
  return AI_MANAGED_CATEGORY_SET.has(slug);
}

export const AI_MANAGED_CATEGORY_SEED_ROWS: Array<{
  slug: AiManagedCategorySlug;
  name: string;
  sortOrder: number;
  color: string;
}> = [
  { slug: 'at-risk', name: 'At risk', sortOrder: 100, color: '#dc2626' },
  { slug: 'new-bookings', name: 'New Bookings', sortOrder: 110, color: '#2563eb' },
  { slug: 'groups-events', name: 'Groups & Events', sortOrder: 120, color: '#7c3aed' },
  { slug: 'ops', name: 'Ops', sortOrder: 130, color: '#64748b' },
  { slug: 'urgent', name: 'Urgent', sortOrder: 10, color: '#dc2626' },
];
