export type CenturionRateBoard =
  | 'room_only'
  | 'bed_breakfast'
  | 'dinner_bed_breakfast'
  | 'unknown';

export type CenturionRatePlan = {
  name: string;
  mealPlan: CenturionRateBoard;
  contract?: boolean;
  government?: boolean;
  /** Known event rates, shown separately from public/contract/government plans. */
  event?: boolean;
};

/**
 * Static UI catalogue only; this is not availability or entitlement data.
 * BAR, BARRO, NCOR1B and BWKPB labels come from the local side-pane demo (a mock, not an HMS read); NCOR2B's label matches a
 * checked-in native description; DBB's label/board follow the lane plan. Other unverified labels use the code, not a guessed name.
 * Confirmed boards are BAR (bed & breakfast), BARRO (room only), and DBB (dinner & bed & breakfast); every other
 * board stays `unknown` when the cited evidence does not establish it. NGOVB's government grouping is inferred from its
 * native code token, not a confirmed label or board. The live quote's own label and negotiated flag remain authoritative.
 */
export const CENTURION_RATE_CATALOGUE = {
  BAR: { name: 'Best Available Rate', mealPlan: 'bed_breakfast' },
  BARRO: { name: 'BAR Room Only', mealPlan: 'room_only' },
  DBB: { name: 'Dinner, Bed & Breakfast', mealPlan: 'dinner_bed_breakfast' },
  DBBX: { name: 'DBBX', mealPlan: 'unknown' },
  NCOR1B: { name: 'Corporate Negotiated', mealPlan: 'unknown', contract: true },
  NCOR2B: { name: 'Negotiated Contracted Rate 2', mealPlan: 'unknown', contract: true },
  GNC3B: { name: 'GNC3B', mealPlan: 'unknown', event: true },
  GNC4B: { name: 'GNC4B', mealPlan: 'unknown', event: true },
  BCO1B: { name: 'BCO1B', mealPlan: 'unknown', contract: true },
  BCO2B: { name: 'BCO2B', mealPlan: 'unknown', contract: true },
  BBP: { name: 'BBP', mealPlan: 'unknown' },
  BWKPB: { name: 'Weekend Promo Rate', mealPlan: 'unknown' },
  NGOVB: { name: 'NGOVB', mealPlan: 'unknown', government: true },
  // Observed stay codes only; native lookup supplies meaning, board and eligibility.
  NGOVDB: { name: 'NGOVDB', mealPlan: 'unknown' },
  BOTAB: { name: 'BOTAB', mealPlan: 'unknown' },
} as const satisfies Record<string, CenturionRatePlan>;

export type CenturionRateCode = keyof typeof CENTURION_RATE_CATALOGUE;
export type CenturionRateCatalogueEntry = CenturionRatePlan & { code: CenturionRateCode };

export const CENTURION_RATE_PLANS: CenturionRateCatalogueEntry[] = Object.keys(
  CENTURION_RATE_CATALOGUE,
).map((code) => ({
  code: code as CenturionRateCode,
  ...CENTURION_RATE_CATALOGUE[code as CenturionRateCode],
}));

export const CENTURION_OVERRIDE_RATE_CODES = ['NCOR1B', 'NCOR2B', 'BAR', 'GNC3B', 'GNC4B'] as const;
export const CENTURION_EVENT_RATE_CODES = ['GNC3B', 'GNC4B'] as const;

