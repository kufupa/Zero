import type {
  QuoteOffer,
  QuoteWorkflowPhase,
  StayGroupRequirement,
} from './types';

export type QuoteFixtureId =
  | 'public-single'
  | 'agency-contract'
  | 'mixed-same-dates'
  | 'staggered-dates'
  | 'varying-nights'
  | 'ro-vs-bb'
  | 'attachment-dependent'
  | 'missing-fields'
  | 'unsupported'
  | 'source-failure'
  | 'selection-change'
  | 'staff-invalidate'
  | 'failed-run'
  | 'uncertain-native';

export type QuoteFixture = {
  id: QuoteFixtureId;
  phase: QuoteWorkflowPhase;
  groups: StayGroupRequirement[];
  offers: QuoteOffer[];
  secondaryAsks: string[];
  alternatives: string[];
  missing?: string[];
  attachmentFilenamesOnly?: string[];
  reviewedReplyHtml?: string;
  retryGuidance?: string;
};

const unavailableShot = { unavailable: true as const, reason: 'No authorised screenshot is tied to this tool run.' };

function group(
  id: string,
  arrivalDate: string,
  departureDate: string,
  extra: Partial<StayGroupRequirement> = {},
): StayGroupRequirement {
  return {
    id,
    arrivalDate,
    departureDate,
    quantity: 1,
    roomPreference: 'standard king',
    adults: 1,
    childrenAges: [],
    board: 'bb',
    specialRequests: [],
    fields: {
      arrivalDate: 'extracted',
      departureDate: 'extracted',
      adults: extra.adults === undefined ? 'extracted' : extra.fields?.adults ?? 'extracted',
    },
    ...extra,
  };
}

function offer(over: Partial<QuoteOffer> & Pick<QuoteOffer, 'id' | 'kind' | 'stayTotalMinor' | 'quoteRequestKey'>): QuoteOffer {
  return {
    roomCode: 'SKNG',
    roomLabel: 'Standard King',
    board: 'bb',
    rateCode: 'BAR',
    currency: 'ZAR',
    nightly: [{ date: '2026-11-12', amountMinor: over.stayTotalMinor }],
    observedAt: '2026-10-05T12:00:00Z',
    sourceRef: `src-${over.id}`,
    restrictions: [],
    combinable: over.kind === 'allocation',
    screenshot: unavailableShot,
    ...over,
  };
}

const FIXTURES: Record<QuoteFixtureId, QuoteFixture> = {
  'public-single': {
    id: 'public-single',
    phase: 'results',
    groups: [group('g1', '2026-11-12', '2026-11-14')],
    offers: [
      offer({
        id: 'pub-1',
        kind: 'allocation',
        stayTotalMinor: 272000,
        quoteRequestKey: '2026-11-12:2026-11-14',
        nightly: [
          { date: '2026-11-12', amountMinor: 136000 },
          { date: '2026-11-13', amountMinor: 136000 },
        ],
      }),
    ],
    secondaryAsks: [],
    alternatives: [],
  },
  'agency-contract': {
    id: 'agency-contract',
    phase: 'results',
    groups: [
      group('g1', '2026-11-12', '2026-11-14', {
        organisation: 'Provincial Treasury',
        adults: 1,
        board: 'dinner_bb',
      }),
    ],
    offers: [
      offer({
        id: 'ngov-1',
        kind: 'allocation',
        stayTotalMinor: 850000,
        rateCode: 'NGOVDB',
        board: 'dinner_bb',
        quoteRequestKey: '2026-11-12:2026-11-14',
        nightly: Array.from({ length: 5 }, (_, i) => ({
          date: `2026-10-${String(11 + i).padStart(2, '0')}`,
          amountMinor: 170000,
        })),
      }),
    ],
    secondaryAsks: [],
    alternatives: [],
  },
  'mixed-same-dates': {
    id: 'mixed-same-dates',
    phase: 'results',
    groups: [
      group('g-double', '2026-10-16', '2026-10-18', { adults: 2, quantity: 1, roomPreference: 'twin' }),
      group('g-single', '2026-10-16', '2026-10-18', { adults: 1, quantity: 2, roomPreference: 'single' }),
    ],
    offers: [
      offer({
        id: 'mix-a',
        kind: 'allocation',
        stayTotalMinor: 626000,
        quoteRequestKey: '2026-10-16:2026-10-18',
        roomLabel: 'Standard Twin',
      }),
      offer({
        id: 'mix-b',
        kind: 'allocation',
        stayTotalMinor: 566000,
        quoteRequestKey: '2026-10-16:2026-10-18',
        roomLabel: 'Standard Queen',
      }),
      offer({
        id: 'mix-c',
        kind: 'allocation',
        stayTotalMinor: 566000,
        quoteRequestKey: '2026-10-16:2026-10-18',
        roomLabel: 'Standard Queen',
      }),
    ],
    secondaryAsks: [],
    alternatives: [],
  },
  'staggered-dates': {
    id: 'staggered-dates',
    phase: 'results',
    groups: [
      group('stay-a', '2026-11-02', '2026-11-04'),
      group('stay-b', '2026-11-10', '2026-11-12'),
    ],
    offers: [
      offer({
        id: 'st-a',
        kind: 'allocation',
        stayTotalMinor: 272000,
        quoteRequestKey: '2026-11-02:2026-11-04',
      }),
      offer({
        id: 'st-b',
        kind: 'allocation',
        stayTotalMinor: 272000,
        quoteRequestKey: '2026-11-10:2026-11-12',
      }),
    ],
    secondaryAsks: [],
    alternatives: [],
  },
  'varying-nights': {
    id: 'varying-nights',
    phase: 'results',
    groups: [group('g1', '2026-10-12', '2026-10-15')],
    offers: [
      offer({
        id: 'var-1',
        kind: 'allocation',
        stayTotalMinor: 630000,
        quoteRequestKey: '2026-10-12:2026-10-15',
        nightly: [
          { date: '2026-10-12', amountMinor: 178000 },
          { date: '2026-10-13', amountMinor: 226000 },
          { date: '2026-10-14', amountMinor: 226000 },
        ],
      }),
    ],
    secondaryAsks: [],
    alternatives: [],
  },
  'ro-vs-bb': {
    id: 'ro-vs-bb',
    phase: 'results',
    groups: [group('g1', '2026-11-12', '2026-11-13')],
    offers: [
      offer({
        id: 'bb-1',
        kind: 'allocation',
        stayTotalMinor: 214000,
        board: 'bb',
        quoteRequestKey: '2026-11-12:2026-11-13',
      }),
      offer({
        id: 'ro-1',
        kind: 'alternative',
        stayTotalMinor: 190000,
        board: 'room_only',
        rateCode: 'BARRO',
        combinable: false,
        quoteRequestKey: '2026-11-12:2026-11-13',
      }),
    ],
    secondaryAsks: [],
    alternatives: ['RO'],
  },
  'attachment-dependent': {
    id: 'attachment-dependent',
    phase: 'missing_source',
    groups: [],
    offers: [],
    secondaryAsks: [],
    alternatives: [],
    missing: ['att-rooming-list'],
    attachmentFilenamesOnly: ['rooming-list.pdf'],
  },
  'missing-fields': {
    id: 'missing-fields',
    phase: 'requirements',
    groups: [
      group('g1', undefined as unknown as string, undefined as unknown as string, {
        arrivalDate: undefined,
        departureDate: undefined,
        fields: { arrivalDate: 'missing', departureDate: 'missing', adults: 'extracted' },
      }),
    ],
    offers: [],
    secondaryAsks: ['How many children, and what ages?'],
    alternatives: [],
  },
  unsupported: {
    id: 'unsupported',
    phase: 'unsupported',
    groups: [],
    offers: [],
    secondaryAsks: [],
    alternatives: [],
  },
  'source-failure': {
    id: 'source-failure',
    phase: 'failed',
    groups: [],
    offers: [],
    secondaryAsks: [],
    alternatives: [],
  },
  'selection-change': {
    id: 'selection-change',
    phase: 'tools',
    groups: [group('g1', '2026-11-12', '2026-11-14')],
    offers: [],
    secondaryAsks: [],
    alternatives: [],
  },
  'staff-invalidate': {
    id: 'staff-invalidate',
    phase: 'results',
    groups: [group('g1', '2026-11-12', '2026-11-14')],
    offers: [
      offer({
        id: 'inv-1',
        kind: 'allocation',
        stayTotalMinor: 272000,
        quoteRequestKey: '2026-11-12:2026-11-14',
      }),
    ],
    secondaryAsks: [],
    alternatives: [],
  },
  'failed-run': {
    id: 'failed-run',
    phase: 'tools',
    groups: [group('g1', '2026-11-12', '2026-11-14')],
    offers: [],
    secondaryAsks: [],
    alternatives: [],
    retryGuidance: 'The read failed before a quote result was stored. Approve the same step again; do not assume inventory is held.',
  },
  'uncertain-native': {
    id: 'uncertain-native',
    phase: 'native_unknown',
    groups: [group('g1', '2026-11-12', '2026-11-14')],
    offers: [
      offer({
        id: 'nat-1',
        kind: 'allocation',
        stayTotalMinor: 272000,
        quoteRequestKey: '2026-11-12:2026-11-14',
      }),
    ],
    secondaryAsks: ['Please also confirm parking.'],
    alternatives: [],
    reviewedReplyHtml: '<p>Parking is available on site.</p>',
  },
};

export const FIXTURE_PDF = {
  fileName: 'Quote-fixture-not-live-hms.pdf',
  bytesBase64: 'JVBERi0xLjQK',
};

export function pickFixtureForSession(groups: StayGroupRequirement[]): QuoteFixtureId {
  if (groups.some((group) => group.organisation?.trim())) return 'agency-contract';
  if (groups.length > 1) {
    const first = `${groups[0]?.arrivalDate ?? ''}:${groups[0]?.departureDate ?? ''}`;
    const same = groups.every((group) => `${group.arrivalDate ?? ''}:${group.departureDate ?? ''}` === first);
    return same ? 'mixed-same-dates' : 'staggered-dates';
  }
  if (groups.some((group) => group.board === 'room_only') || groups.some((group) => group.board === 'bb')) {
    if (groups.length === 1 && groups[0]?.board === 'room_only') return 'ro-vs-bb';
  }
  return 'public-single';
}

export function fixtureReplyHtml(fixture: QuoteFixture, guestFirstName = 'Guest'): string {
  if (fixture.reviewedReplyHtml) return fixture.reviewedReplyHtml;
  const secondary = fixture.secondaryAsks.length
    ? `<p>${fixture.secondaryAsks.join(' ')}</p>`
    : '';
  const alternatives = fixture.alternatives.length
    ? `<p>Requested alternatives remain available in this email and are not booked: ${fixture.alternatives.join(', ')}.</p>`
    : '';
  return `<div><p>Good day ${guestFirstName},</p><p>Please see attached quotation for the selected allocation only.</p>${secondary}${alternatives}<p>Kind regards,</p></div>`;
}

export function loadQuoteFixture(id: QuoteFixtureId): QuoteFixture {
  const fixture = FIXTURES[id];
  if (!fixture) throw new Error(`unknown quote fixture: ${id}`);
  return structuredClone(fixture);
}

export function quoteRequestKeys(fixture: QuoteFixture): string[] {
  if (fixture.offers.length > 0) {
    return fixture.offers.filter((o) => o.kind === 'allocation').map((o) => o.quoteRequestKey);
  }
  return fixture.groups.map((g) => `${g.arrivalDate ?? ''}:${g.departureDate ?? ''}`);
}
