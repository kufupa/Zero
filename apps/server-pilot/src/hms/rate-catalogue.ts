import { ROOM_TYPE_NAMES } from '../ai/room-types.js';
import { readShuttleProviderConfig, type ShuttleProviderConfig } from '../ai/shuttle-draft.js';
import {
  PROFILE_SALES_STRATEGY_CODES,
  profileFor,
  type PropertyProfile,
} from '../../tooling/playwright-quote/property-profile.mjs';

import { CENTURION_RATE_CATALOGUE, CENTURION_RATE_PLANS, CENTURION_OVERRIDE_RATE_CODES, CENTURION_EVENT_RATE_CODES, type CenturionRatePlan, type CenturionRateBoard } from './centurion-rate-catalogue.js';
export { CENTURION_RATE_CATALOGUE, CENTURION_RATE_PLANS, CENTURION_OVERRIDE_RATE_CODES, CENTURION_EVENT_RATE_CODES };
export type { CenturionRateBoard, CenturionRatePlan, CenturionRateCode, CenturionRateCatalogueEntry } from './centurion-rate-catalogue.js';

type HmsPropertyCode = 'HRCEN' | 'HRDAV';
type QuotePaneBoard = 'room_only' | 'bb' | 'dinner_bb';
type PropertyRatePlan = CenturionRatePlan & { code: string };
type NativeRatePlan = { code: string; name: string };

export type QuoteSalesStrategyCode = 'BAR' | 'PROMO' | 'PRESET' | 'WS' | 'NC' | 'GOV' | 'AIR' | 'DOML' | 'OTHER';
export type QuoteSalesStrategy = {
  code: QuoteSalesStrategyCode;
  label: string;
  /** Value sent to the quote tool. Government keeps the legacy request value used by prepared HRCEN quotes. */
  requestValue: QuoteSalesStrategyCode | 'Government';
};

const KNOWN_SALES_STRATEGY_CODES = new Set<QuoteSalesStrategyCode>(PROFILE_SALES_STRATEGY_CODES);

export type PropertyQuotePaneConfig = {
  transportId: string;
  propertyCode: HmsPropertyCode;
  roomTypes: Array<{ code: string; label: string }>;
  ratePlans: PropertyRatePlan[];
  mealPlans: QuotePaneBoard[];
  salesStrategies: QuoteSalesStrategy[];
  overrideRateCodes: string[];
  eventRateCodes: string[];
  shuttle?: ShuttleProviderConfig | null;
};

const PANE_BOARD_ORDER: readonly QuotePaneBoard[] = ['room_only', 'bb', 'dinner_bb'];

function registeredProfile(propertyCode: string): PropertyProfile | null {
  return profileFor(propertyCode);
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
      /[<>\p{Cc}]/u.test(label)
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
  const known = new Set(plans.map((plan) => boardForCatalogue(plan.mealPlan)).filter(Boolean));
  return PANE_BOARD_ORDER.filter((board) => known.has(board));
}

/** Prefer captured HMS rate plans when available; static entries only cover catalog absence. */
export async function loadNativeRatePlans(
  propertyCode: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NativeRatePlan[] | null> {
  const path = env.HMS_NATIVE_CATALOG_PATH;
  if (!path) return null;
  const module = await import(new URL('../../tooling/hms-cloud/hms-native-catalog.mjs', import.meta.url).href) as {
    loadHmsNativeCatalog: (input: { path: string; propertyCode: string }) => Promise<
      { status: string; catalog?: { catalogs?: { ratePlans?: { records?: unknown[] } } } }
    >;
  };
  const loaded = await module.loadHmsNativeCatalog({ path, propertyCode });
  if (loaded.status !== 'available') return null;
  const records = loaded.catalog?.catalogs?.ratePlans?.records;
  if (!Array.isArray(records)) return null;
  const rates = new Map<string, NativeRatePlan>();
  for (const raw of records) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code.trim() : '';
    const meaning = typeof record.meaning === 'string' ? record.meaning.trim() : '';
    if (code) rates.set(code, { code, name: meaning || code });
  }
  return rates.size ? [...rates.values()] : null;
}

/** Build safe pane choices for a property already resolved from the active mailbox registry entry. */
export async function quotePaneConfigForProperty(
  propertyCode: string,
  transportId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PropertyQuotePaneConfig | null> {
  if (propertyCode === 'HRCEN') {
    const nativeRates = await loadNativeRatePlans(propertyCode, env);
    const ratePlans: PropertyRatePlan[] = nativeRates?.map(({ code, name }) => {
      const known = CENTURION_RATE_CATALOGUE[code as keyof typeof CENTURION_RATE_CATALOGUE];
      return known ? { code, ...known, name } : { code, mealPlan: 'unknown' as const, name };
    }) ?? CENTURION_RATE_PLANS;
    return {
      transportId,
      propertyCode,
      roomTypes: Object.entries(ROOM_TYPE_NAMES).map(([code, label]) => ({ code, label })),
      ratePlans,
      mealPlans: boardsForPlans(ratePlans),
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
    mealPlan: ratePlanBoard(plan.mealPlan),
    ...(plan.contract ? { contract: true } : {}),
    ...(plan.government ? { government: true } : {}),
    ...(plan.event ? { event: true } : {}),
  }));
  return {
    transportId,
    propertyCode,
    roomTypes: Object.entries(profile.rooms).map(([code, room]) => ({ code, label: room.label })),
    ratePlans,
    mealPlans: boardsForPlans(ratePlans),
    salesStrategies: quoteSalesStrategiesFromRegistry(propertyCode, profile.salesStrategies),
    overrideRateCodes: ratePlans.map(({ code }) => code),
    eventRateCodes: ratePlans.filter(({ event }) => event).map(({ code }) => code),
    shuttle: readShuttleProviderConfig((profile as PropertyProfile & { shuttle?: unknown }).shuttle),
  };
}
