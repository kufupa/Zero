/** Legacy primary folders retained while workflow triage consumers migrate. */
export const LEGACY_PRIMARY_CATEGORY_SLUGS = [
  'new-bookings',
  'groups-events',
  'at-risk',
  'ops',
] as const;

/** Canonical Phase 1 workflow folders. `urgent` remains an overlay. */
export const AI_WORKFLOW_PRIMARY_SLUGS = [
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

/**
 * Legacy alias retained until the triage schema switches to workflow slugs.
 * New consumers must use AI_WORKFLOW_PRIMARY_SLUGS.
 */
export const AI_PRIMARY_CATEGORY_SLUGS = LEGACY_PRIMARY_CATEGORY_SLUGS;

export const AI_OVERLAY_CATEGORY_SLUGS = ['urgent'] as const;

export const AI_MANAGED_CATEGORY_SLUGS = [
  ...AI_PRIMARY_CATEGORY_SLUGS,
  ...AI_OVERLAY_CATEGORY_SLUGS,
] as const;

export type AiPrimaryCategorySlug = (typeof AI_PRIMARY_CATEGORY_SLUGS)[number];
export type AiWorkflowPrimarySlug = (typeof AI_WORKFLOW_PRIMARY_SLUGS)[number];
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
