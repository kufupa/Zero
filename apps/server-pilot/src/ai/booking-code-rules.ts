import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * CLIENT_QUESTION: track / sourceOfBusiness / guaranteeType per party class
 * are all-null until HMS code mining fills MINED_CROSSTAB (n≥3 and ≥60% support).
 * Ask staff which codes to prefill when mining yields fewer than 15 reads.
 */

export const PARTY_CLASSES = ['agency', 'government', 'organization', 'private'] as const;
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
  agency: {
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
        guaranteeType: { enum: string[] };
      };
    };
  };
};

const ENUMS = {
  track: new Set(schema.$defs.request.properties.track.enum),
  sourceOfBusiness: new Set(schema.$defs.request.properties.sourceOfBusiness.enum),
  guaranteeType: new Set(schema.$defs.request.properties.guaranteeType.enum),
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
