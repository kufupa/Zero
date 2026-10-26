import { ROOM_TYPE_NAMES } from '../ai/room-types.js';
import {
  PROFILE_SALES_STRATEGY_CODES,
  profileFor,
} from '../../tooling/playwright-quote/property-profile.mjs';

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
 * BAR, BARRO, NCOR1B and BWKPB labels come from the local side-pane demo (a mock, not an HMS read); NCOR2B's label matches a
 * checked-in native description; DBB's label/board follow the lane plan. Other unverified labels use the code, not a guessed name.
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

export const CENTURION_OVERRIDE_RATE_CODES = ['NCOR1B', 'NCOR2B', 'BAR', 'GNC3B', 'GNC4B'] as const;
export const CENTURION_EVENT_RATE_CODES = ['GNC3B', 'GNC4B'] as const;

type HmsPropertyCode = 'HRCEN' | 'HRDAV';
type QuotePaneBoard = 'room_only' | 'bb' | 'dinner_bb';
type PropertyRatePlan = CenturionRatePlan & { code: string };

export type QuoteSalesStrategyCode = 'BAR' | 'PROMO' | 'PRESET' | 'WS' | 'NC' | 'GOV' | 'AIR' | 'DOML' | 'OTHER';
export type QuoteSalesStrategy = {
  code: QuoteSalesStrategyCode;
  label: string;
  /** Value sent to the quote tool. Government keeps the legacy request value used by prepared HRCEN quotes. */
  requestValue: QuoteSalesStrategyCode | 'Government';
};

const KNOWN_SALES_STRATEGY_CODES = new Set<QuoteSalesStrategyCode>(
  PROFILE_SALES_STRATEGY_CODES as readonly QuoteSalesStrategyCode[],
);

export type PropertyQuotePaneConfig = {
  transportId: string;
  propertyCode: HmsPropertyCode;
  roomTypes: Array<{ code: string; label: string }>;
  ratePlans: PropertyRatePlan[];
  boards: QuotePaneBoard[];
  salesStrategies: QuoteSalesStrategy[];
  overrideRateCodes: string[];
  eventRateCodes: string[];
};

type RegistryQuoteProfile = {
  rooms?: Record<string, { label: string }>;
  ratePlans?: Record<string, {
    label: string;
    board: string;
    contract?: boolean;
    government?: boolean;
    event?: boolean;
  }>;
  salesStrategies?: Array<{ value: string; display: string }>;
};

const PANE_BOARD_ORDER: readonly QuotePaneBoard[] = ['room_only', 'bb', 'dinner_bb'];

function registeredProfile(propertyCode: string): RegistryQuoteProfile | null {
  return profileFor(propertyCode) as RegistryQuoteProfile | null;
}

/** Only registry-listed native codes become pane choices. BAR is pinned first when the registry offers it. */
export function quoteSalesStrategiesFromRegistry(
  propertyCode: string,
  raw: unknown,
): QuoteSalesStrategy[] {
  const profile = registeredProfile(propertyCode);
  if (!profile) return [];
  const rows = Array.isArray(raw) ? raw : profile.salesStrategies;
  if (!Array.isArray(rows)) return [];
  const seen = new Set<QuoteSalesStrategyCode>();
  const strategies: QuoteSalesStrategy[] = [];
  for (const candidate of rows) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const row = candidate as { value?: unknown; display?: unknown };
    const code = typeof row.value === 'string' ? row.value.trim().toUpperCase() : '';
    const label = typeof row.display === 'string' ? row.display.trim() : '';
    if (
      !KNOWN_SALES_STRATEGY_CODES.has(code as QuoteSalesStrategyCode) ||
      seen.has(code as QuoteSalesStrategyCode) ||
      !label ||
      label.length > 80 ||
      /[<>\u0000-\u001f\u007f]/.test(label)
    ) continue;
    const safeCode = code as QuoteSalesStrategyCode;
    seen.add(safeCode);
    strategies.push({
      code: safeCode,
      label,
      requestValue: safeCode === 'GOV' ? 'Government' : safeCode,
    });
  }
  return strategies.sort((left, right) => Number(right.code === 'BAR') - Number(left.code === 'BAR'));
}

function boardForCatalogue(board: string): QuotePaneBoard | null {
  if (board === 'room_only') return 'room_only';
  if (board === 'bb' || board === 'bed_breakfast') return 'bb';
  if (board === 'dinner_bb' || board === 'dinner_bed_breakfast') return 'dinner_bb';
  return null;
}

function ratePlanBoard(board: string): CenturionRateBoard {
  const known = boardForCatalogue(board);
  if (known === 'bb') return 'bed_breakfast';
  if (known === 'dinner_bb') return 'dinner_bed_breakfast';
  return known ?? 'unknown';
}

function boardsForPlans(plans: readonly PropertyRatePlan[]): QuotePaneBoard[] {
  const known = new Set(plans.map((plan) => boardForCatalogue(plan.board)).filter(Boolean));
  return PANE_BOARD_ORDER.filter((board) => known.has(board));
}

/** Build safe pane choices for a property already resolved from the active mailbox registry entry. */
export async function quotePaneConfigForProperty(
  propertyCode: string,
  transportId: string,
): Promise<PropertyQuotePaneConfig | null> {
  if (propertyCode === 'HRCEN') {
    return {
      transportId,
      propertyCode,
      roomTypes: Object.entries(ROOM_TYPE_NAMES).map(([code, label]) => ({ code, label })),
      ratePlans: CENTURION_RATE_PLANS,
      boards: boardsForPlans(CENTURION_RATE_PLANS),
      salesStrategies: quoteSalesStrategiesFromRegistry(propertyCode, null),
      overrideRateCodes: [...CENTURION_OVERRIDE_RATE_CODES],
      eventRateCodes: [...CENTURION_EVENT_RATE_CODES],
    };
  }
  if (propertyCode !== 'HRDAV') return null;

  const profile = registeredProfile(propertyCode);
  if (!profile?.rooms || !profile.ratePlans) return null;
  const ratePlans: PropertyRatePlan[] = Object.entries(profile.ratePlans).map(([code, plan]) => ({
    code,
    name: plan.label,
    board: ratePlanBoard(plan.board),
    ...(plan.contract ? { contract: true } : {}),
    ...(plan.government ? { government: true } : {}),
    ...(plan.event ? { event: true } : {}),
  }));
  return {
    transportId,
    propertyCode,
    roomTypes: Object.entries(profile.rooms).map(([code, room]) => ({ code, label: room.label })),
    ratePlans,
    boards: boardsForPlans(ratePlans),
    salesStrategies: quoteSalesStrategiesFromRegistry(propertyCode, profile.salesStrategies),
    overrideRateCodes: ratePlans.map(({ code }) => code),
    eventRateCodes: ratePlans.filter(({ event }) => event).map(({ code }) => code),
  };
}
