import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_REGISTRY } from '../../tooling/playwright-quote/property-registry.mjs';
import { profileFor } from '../../tooling/playwright-quote/property-profile.mjs';
import { z } from 'zod';

/**
 * CLIENT_QUESTION: track / sourceOfBusiness / guaranteeType per party class
 * are all-null until HMS code mining fills MINED_CROSSTAB (n≥3 and ≥60% support).
 * Ask staff which codes to prefill when mining yields fewer than 15 reads.
 */

export const PARTY_CLASSES = ['bookingAgency', 'government', 'organization', 'private'] as const;
export type PartyClass = (typeof PARTY_CLASSES)[number];

export type BookingCodeDefaults = {
  track: string | null;
  sourceOfBusiness: string | null;
  guaranteeType: string | null;
};

export type CrosstabField = { value: string | null; support: number };
export type CrosstabRow = {
  n: number;
  track: CrosstabField;
  sourceOfBusiness: CrosstabField;
  guaranteeType: CrosstabField;
};

/** Frozen mining table: codes, counts, party class only. No names. */
export const MINED_CROSSTAB: Readonly<Record<PartyClass, CrosstabRow>> = {
  bookingAgency: {
    n: 0,
    track: { value: null, support: 0 },
    sourceOfBusiness: { value: null, support: 0 },
    guaranteeType: { value: null, support: 0 },
  },
  government: {
    n: 0,
    track: { value: null, support: 0 },
    sourceOfBusiness: { value: null, support: 0 },
    guaranteeType: { value: null, support: 0 },
  },
  organization: {
    n: 0,
    track: { value: null, support: 0 },
    sourceOfBusiness: { value: null, support: 0 },
    guaranteeType: { value: null, support: 0 },
  },
  private: {
    n: 0,
    track: { value: null, support: 0 },
    sourceOfBusiness: { value: null, support: 0 },
    guaranteeType: { value: null, support: 0 },
  },
};

const TRACK_LABELS: Record<string, string> = {
  'Airline Rate': 'AIR',
  'Best Available': 'BAR',
  Complimentary: 'COM',
  'Corporate Rate': 'COR',
  'Day Use': 'DAY',
  'Domestic Leisure': 'DOML',
  Educational: 'EDU',
  'Extended Stay': 'EXST',
  'GDS BAR': 'GDSB',
  'GDS Negotiated': 'GDSN',
  'Group and Convention': 'GNC',
  Government: 'GOV',
  'House Use': 'HSE',
  'Legacy Lifestyle Corporate': 'LLC',
  'Online Chinese Market': 'OTA1',
  'OTA Automated': 'OTAA',
  'Legacy Public Website': 'OWS',
  Promotions: 'PROMO',
  'Redemption Rate': 'RED',
  Specials: 'SPE',
  'STO Rate': 'STO',
};

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../tooling/playwright-quote/create-tool.schema.json', import.meta.url)),
    'utf8',
  ),
) as {
  $defs: {
    request: {
      properties: {
        track: { enum: string[] };
        sourceOfBusiness: { enum: string[] };
      };
    };
  };
};

const ENUMS = {
  track: new Set(schema.$defs.request.properties.track.enum),
  sourceOfBusiness: new Set(schema.$defs.request.properties.sourceOfBusiness.enum),
  guaranteeType: new Set(
    PROPERTY_REGISTRY.properties.flatMap((property) =>
      profileFor(property.propertyCode)?.createForm?.options?.guaranteetype?.choices?.map((choice) => choice.display) ?? [],
    ),
  ),
};

function normalizeCreateLabelsLike(field: keyof BookingCodeDefaults, value: string): string {
  if (field === 'track' && TRACK_LABELS[value]) return TRACK_LABELS[value];
  return value;
}

function pickField(
  n: number,
  field: keyof BookingCodeDefaults,
  cell: CrosstabField,
): string | null {
  if (n < 3 || cell.support < 0.6) return null;
  const raw = typeof cell.value === 'string' ? cell.value.trim() : '';
  if (!raw) return null;
  const normalized = normalizeCreateLabelsLike(field, raw);
  return ENUMS[field].has(normalized) ? normalized : null;
}

export function defaultsFromCrosstabRow(row: CrosstabRow): BookingCodeDefaults {
  return {
    track: pickField(row.n, 'track', row.track),
    sourceOfBusiness: pickField(row.n, 'sourceOfBusiness', row.sourceOfBusiness),
    guaranteeType: pickField(row.n, 'guaranteeType', row.guaranteeType),
  };
}

export function bookingCodeDefaults(kind: string): BookingCodeDefaults {
  if (!(PARTY_CLASSES as readonly string[]).includes(kind)) {
    return { track: null, sourceOfBusiness: null, guaranteeType: null };
  }
  return defaultsFromCrosstabRow(MINED_CROSSTAB[kind as PartyClass]);
}

const commissionCatalogSchema = z.object({ capturedAt: z.string().datetime({ offset: true }), catalogs: z.object({
  agencies: z.object({ records: z.array(z.object({ nativeId: z.string().nullable(),
    capturedAt: z.string().datetime({ offset: true }),
    commissionPercent: z.number().min(0).max(100).nullable(), commissionEvidence: z.object({
      directory: z.object({ mapping: z.string(), confidence: z.number().nullable() }).nullable(),
      mapping: z.object({ basis: z.literal('same_agency_unsaved_native_form_readback'),
        numerator: z.number().int().nonnegative(), denominator: z.number().int().nonnegative() }).nullable(),
    }) })) }),
}) });

/** A selected native agency ID can use a currently verified directory percentage. */
export async function loadAgencyCommission(input: { propertyCode: string; nativeId: string; env?: NodeJS.ProcessEnv }): Promise<
  { status: 'verified'; percent: number; capturedAt: string; confidence: number; numerator: number; denominator: number } |
  { status: 'unavailable' | 'not_found'; issue: string }
> {
  const module = await import('../../tooling/hms-cloud/hms-native-catalog.mjs');
  const options = module.nativeCatalogReadOptions({ propertyCode: input.propertyCode, env: input.env ?? process.env });
  if (!options.path) return { status: 'unavailable', issue: 'catalog_path_missing' };
  const loaded = await module.loadHmsNativeCatalog(options);
  if (loaded.status !== 'available') return { status: 'unavailable', issue: loaded.issue };
  const parsed = commissionCatalogSchema.safeParse(loaded.catalog);
  if (!parsed.success) return { status: 'unavailable', issue: 'commission_catalog_invalid' };
  const rows = parsed.data.catalogs.agencies.records.filter(row => row.nativeId === input.nativeId);
  if (rows.length !== 1 || rows[0]?.commissionPercent == null ||
      rows[0].commissionEvidence.directory?.mapping !== 'correlated_agency_directory_percent' ||
      (rows[0].commissionEvidence.directory.confidence ?? 0) < 0.9 || !rows[0].commissionEvidence.mapping) {
    return { status: 'not_found', issue: 'commission_unverified' };
  }
  const { numerator, denominator } = rows[0].commissionEvidence.mapping;
  const confidence = numerator / denominator;
  if (!denominator || numerator > denominator || confidence < 0.9) return { status: 'not_found', issue: 'commission_unverified' };
  return { status: 'verified', percent: rows[0].commissionPercent, capturedAt: rows[0].capturedAt,
    numerator, denominator, confidence };
}

/** Report whether a property-wide native Rate Plan/Meal Plan configuration is available. */
export async function loadNativeRateMealPlan(input: { propertyCode: string; ratePlan: string; env?: NodeJS.ProcessEnv }): Promise<
  { status: 'verified'; mealPlan: string; capturedAt: string } | { status: 'unavailable' | 'not_found'; issue: string }
> {
  const module = await import('../../tooling/hms-cloud/hms-native-catalog.mjs');
  const options = module.nativeCatalogReadOptions({ propertyCode: input.propertyCode, env: input.env ?? process.env });
  if (!options.path) return { status: 'unavailable', issue: 'catalog_path_missing' };
  const loaded = await module.loadHmsNativeCatalog(options);
  if (loaded.status !== 'available') return { status: 'unavailable', issue: loaded.issue };
  // A selected draft readback is not a property-wide configuration: the native
  // rate-change call sends the whole draft, and its dependencies are unknown.
  return { status: 'not_found', issue: 'rate_meal_configuration_unverified' };
}

const nativeCodeCatalogSchema = z.object({ capturedAt: z.string().datetime({ offset: true }), catalogs: z.record(z.object({
  scope: z.object({ wholeCatalogComplete: z.boolean() }), coverage: z.object({ complete: z.boolean() }),
  records: z.array(z.object({ code: z.string().nullable(), meaning: z.string().nullable(),
    capturedAt: z.string().datetime({ offset: true }) })),
})) });

/** Current complete native codes; historical guidance still needs a unique matching code or meaning. */
export async function loadNativeBookingCodes(input: { propertyCode: string; kind: 'guaranteeTypes' | 'trackSubsegment';
  env?: NodeJS.ProcessEnv }): Promise<
  { status: 'available'; capturedAt: string; records: { code: string | null; meaning: string | null; capturedAt: string }[] } |
  { status: 'unavailable'; issue: string }
> {
  const module = await import('../../tooling/hms-cloud/hms-native-catalog.mjs');
  const options = module.nativeCatalogReadOptions({ propertyCode: input.propertyCode, env: input.env ?? process.env });
  if (!options.path) return { status: 'unavailable', issue: 'catalog_path_missing' };
  const loaded = await module.loadHmsNativeCatalog(options);
  if (loaded.status !== 'available') return { status: 'unavailable', issue: loaded.issue };
  const parsed = nativeCodeCatalogSchema.safeParse(loaded.catalog);
  if (!parsed.success) return { status: 'unavailable', issue: 'booking_code_catalog_invalid' };
  const catalog = parsed.data.catalogs[input.kind];
  if (!catalog || !catalog.scope.wholeCatalogComplete || !catalog.coverage.complete) {
    return { status: 'unavailable', issue: 'booking_code_catalog_incomplete' };
  }
  const capturedAt = catalog.records.length
    ? new Date(catalog.records.reduce((earliest, row) => Math.min(earliest, Date.parse(row.capturedAt)), Infinity)).toISOString()
    : parsed.data.capturedAt;
  return { status: 'available', capturedAt, records: catalog.records };
}
