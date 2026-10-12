export type CenturionRateBoard =
  | 'room_only'
  | 'bed_breakfast'
  | 'dinner_bed_breakfast'
  | 'unknown';

export type CenturionRatePlan = {
  name: string;
  board: CenturionRateBoard;
  contract?: boolean;
  government?: boolean;
  /** Known event rates, shown separately from public/contract/government plans. */
  event?: boolean;
};

/**
 * Static UI catalogue only; this is not availability or entitlement data.
 * BAR, BARRO, and NCOR1B labels are confirmed in the local side-pane demo; NCOR2B's label matches a checked-in native
 * description; DBB's label/board follow the lane plan. Other unverified labels use the code, not a guessed name.
 * Confirmed boards are BAR (bed & breakfast), BARRO (room only), and DBB (dinner & bed & breakfast); every other
 * board stays `unknown` when the cited evidence does not establish it. NGOVB's government grouping is inferred from its
 * native code token, not a confirmed label or board. The live quote's own label and negotiated flag remain authoritative.
 */
export const CENTURION_RATE_CATALOGUE = {
  BAR: { name: 'Best Available Rate', board: 'bed_breakfast' },
  BARRO: { name: 'BAR Room Only', board: 'room_only' },
  DBB: { name: 'Dinner, Bed & Breakfast', board: 'dinner_bed_breakfast' },
  DBBX: { name: 'DBBX', board: 'unknown' },
  NCOR1B: { name: 'Corporate Negotiated', board: 'unknown', contract: true },
  NCOR2B: { name: 'Negotiated Contracted Rate 2', board: 'unknown', contract: true },
  GNC3B: { name: 'GNC3B', board: 'unknown', event: true },
  GNC4B: { name: 'GNC4B', board: 'unknown', event: true },
  BCO1B: { name: 'BCO1B', board: 'unknown', contract: true },
  BCO2B: { name: 'BCO2B', board: 'unknown', contract: true },
  BBP: { name: 'BBP', board: 'unknown' },
  BWKPB: { name: 'Weekend Promo Rate', board: 'unknown' },
  NGOVB: { name: 'NGOVB', board: 'unknown', government: true },
} as const satisfies Record<string, CenturionRatePlan>;

export type CenturionRateCode = keyof typeof CENTURION_RATE_CATALOGUE;
export type CenturionRateCatalogueEntry = CenturionRatePlan & { code: CenturionRateCode };

export const CENTURION_RATE_PLANS: CenturionRateCatalogueEntry[] = Object.keys(
  CENTURION_RATE_CATALOGUE,
).map((code) => ({
  code: code as CenturionRateCode,
  ...CENTURION_RATE_CATALOGUE[code as CenturionRateCode],
}));
