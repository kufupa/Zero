import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeQuoteRequest } from '../../../../../apps/server-pilot/src/hms/quote-request-normalization.js';
import {
  buildHotelAvailabilityReadData,
  buildHotelAvailabilitySearchBody,
  classifyHotelAvailabilityResult,
  hotelAvailabilitySurfaceManifestSchema,
  parseHotelAvailabilityResponse,
} from '../src/hms/hotel-availability-contract.js';
import { buildHotelAvailabilityRequestManifest } from '../src/hms/hotel-availability-manifest.js';
import { buildQuoteStayReadData } from '../../../../../apps/server-pilot/src/hms/quote-stay-contract.js';
import { syntheticQuoteReferenceAuthority } from '../../../../../apps/server-pilot/tests/helpers/quote-reference-authority.js';

const manifest = hotelAvailabilitySurfaceManifestSchema.parse({
  schemaVersion: 1,
  surface: 'hotel_availability',
  functionName: 'OSMPAV',
  openPath: '/web/base/OSMPAV',
  openMethod: 'POST',
  openBody: { FUNCTION_CLASS: 'WEBL', USER_FUNCTION_NAME: 'OSMPAV' },
  searchPath: '/web/base/OSMPAV.HDR.search',
  method: 'POST',
  contentType: 'application/x-www-form-urlencoded',
  noWrite: true,
  fixedBody: { FUNCTION_CLASS: 'WEBL', USER_FUNCTION_NAME: 'OSMPAV' },
  fields: {
    property: 'property',
    arrival: 'arrival',
    departure: 'departure',
    nights: 'nights',
    currency: 'currency',
    adults: 'adults',
    children: 'children',
    childAges: 'childAges',
    roomGroups: 'rooms',
    organization: 'organization',
    agency: 'agency',
    group: 'group',
  },
  roomEncoding: 'json',
  response: {
    rowsPath: 'result.rows',
    successPath: 'result.success',
    datePath: 'date',
    roomTypePath: 'roomType',
    ratePlanPath: 'ratePlan',
    availableCountPath: 'available',
    amountPath: 'amount',
    currencyPath: 'currency',
    restrictionsPath: 'restrictions',
    roomGroupIndexPath: 'roomGroupIndex',
    quantityPath: 'quantity',
    occupancyPricedPath: 'result.occupancyPriced',
    stayTotalPath: 'result.stayTotal',
  },
  discoveryEvidenceSha256: 'a'.repeat(64),
  discoveredAt: '2026-09-16T00:00:00.000Z',
});

function request() {
  const normalized = normalizeQuoteRequest(
    {
      arrival: '2026-09-20',
      departure: '2026-09-22',
      rooms: [
        { quantity: 1, adultsPerRoom: 2, childAges: [5], children: 1, roomTypeRef: 'STD', ratePlanRef: 'BAR' },
        { quantity: 1, adultsPerRoom: 1, childAges: [], roomTypeRef: 'DLX', ratePlanRef: 'BAR2' },
      ],
      currency: 'ZAR',
      organizationRef: 'org-centurion',
      agencyRef: 'agency-7',
      groupRef: 'group-42',
    },
    { referenceAuthority: syntheticQuoteReferenceAuthority },
  );
  if (normalized.status !== 'ready') throw new Error(normalized.unresolvedInputs.join(','));
  return normalized.request;
}

describe('tenant-bound Hotel Availability contract', () => {
  it('resolves standalone runner from the wrapper, independent of caller cwd', () => {
    const wrapper = readFileSync(
      new URL('../scripts/hms-standalone-hotel-availability.sh', import.meta.url),
      'utf8',
    );
    expect(wrapper).toContain('script_dir=');
    expect(wrapper).toContain('workspace_root=');
    expect(wrapper).toContain('"$script_dir/hms-standalone-hotel-availability.ts"');
    expect(wrapper).not.toContain('tsx scripts/hms-standalone-hotel-availability.ts');
  });

  it('does not report ok when derived read data contains scope or currency errors', () => {
    const req = request();
    const parsed = {
      envelopeRecognized: true,
      rows: [
        {
          date: '2026-10-01',
          roomType: 'STD',
          ratePlan: 'BAR',
          availableCount: 2,
          displayedAmount: '1200.00',
          currency: 'USD',
          rateBasis: 'nightly' as const,
          restrictions: ['none'],
          observedAt: '2026-09-16T00:00:00.000Z',
        },
      ],
      unresolvedFields: [],
      currency: 'USD',
      occupancyPriced: true,
      stayTotal: {
        amount: '1200.00',
        currency: 'USD',
        basis: 'per_stay' as const,
        taxTreatment: 'unknown' as const,
      },
    };
    const data = buildHotelAvailabilityReadData({ request: req, parsed });

    expect(data.unresolvedInputs).toEqual(
      expect.arrayContaining(['currency_mismatch']),
    );
    expect(classifyHotelAvailabilityResult({ parsed, data })).toBe('partial');
  });

  it('rejects non-null commercial context when discovered field mapping is absent', () => {
    const unmappedManifest = hotelAvailabilitySurfaceManifestSchema.parse({
      ...manifest,
      fields: {
        ...manifest.fields,
        organization: undefined,
        agency: undefined,
        group: undefined,
      },
    });

    expect(() =>
      buildHotelAvailabilitySearchBody({
        request: request(),
        manifest: unmappedManifest,
      }),
    ).toThrow(/commercial context|organization|agency|group/i);
  });

  it('does not calculate a requested-stay sum from mismatched source quantity', () => {
    const data = buildQuoteStayReadData({
      nightlyObservations: ['2026-09-20', '2026-09-21'].map((date) => ({
        date,
        roomType: 'STD',
        ratePlan: 'BAR',
        availableCount: 2,
        displayedAmount: '1200.00',
        currency: 'ZAR',
        rateBasis: 'nightly' as const,
        restrictions: ['none'],
        observedAt: '2026-09-16T00:00:00.000Z',
        quantity: 1,
      })),
      requestedRooms: 2,
      arrival: '2026-09-20',
      departure: '2026-09-22',
      rooms: [
        {
          quantity: 2,
          adultsPerRoom: 2,
          childAges: [],
          roomTypeRef: 'STD',
          ratePlanRef: 'BAR',
        },
      ],
      currency: 'ZAR',
      sourceCurrency: 'ZAR',
    });

    expect(data.displayRateSum).toBeNull();
    expect(data.unresolvedInputs).toEqual(
      expect.arrayContaining(['quantity_mismatch:room_group:0']),
    );
  });

  it('does not report ok for a wrong date or room/rate scope', () => {
    const req = request();
    const parsed = {
      envelopeRecognized: true,
      rows: [
        {
          date: '2026-10-01',
          roomType: 'OTHER',
          ratePlan: 'OTHER-RATE',
          availableCount: 2,
          displayedAmount: '1200.00',
          currency: 'ZAR',
          rateBasis: 'nightly' as const,
          restrictions: ['none'],
          observedAt: '2026-09-16T00:00:00.000Z',
          roomGroupIndex: 0,
        },
      ],
      unresolvedFields: [],
      currency: 'ZAR',
      occupancyPriced: true,
      stayTotal: {
        amount: '1200.00',
        currency: 'ZAR',
        basis: 'per_stay' as const,
        taxTreatment: 'unknown' as const,
      },
    };
    const data = buildHotelAvailabilityReadData({ request: req, parsed });
    expect(data.unresolvedInputs).toEqual(
      expect.arrayContaining([
        'nightly.out_of_window:2026-10-01',
        'room_type_scope_mismatch:room_group:0',
        'rate_plan_scope_mismatch:room_group:0',
      ]),
    );
    expect(classifyHotelAvailabilityResult({ parsed, data })).not.toBe('ok');
  });

  it('preserves every room group, quantity, child age and exact stay length', () => {
    const body = buildHotelAvailabilitySearchBody({ request: request(), manifest });
    expect(body).toMatchObject({
      property: 'HRCEN',
      arrival: '2026-09-20',
      departure: '2026-09-22',
      nights: '2',
      adults: '3',
      children: '1',
      organization: 'org-centurion',
      agency: 'agency-7',
      group: 'group-42',
    });
    expect(JSON.parse(body.rooms!)).toEqual([
      { quantity: 1, adultsPerRoom: 2, childAges: [5], roomTypeRef: 'STD', ratePlanRef: 'BAR' },
      { quantity: 1, adultsPerRoom: 1, childAges: [], roomTypeRef: 'DLX', ratePlanRef: 'BAR2' },
    ]);
    expect(JSON.parse(body.childAges!)).toEqual([[5], []]);
  });

  it('parses mixed-room Hotel Availability rows only when groups correlate', () => {
    const req = request();
    const parsed = parseHotelAvailabilityResponse(
      JSON.stringify({
        result: {
          success: true,
          occupancyPriced: true,
          stayTotal: '4200.00',
          rows: [
            { date: '2026-09-20', roomType: 'STD', ratePlan: 'BAR', available: 2, amount: '1200.00', currency: 'ZAR', restrictions: ['none'], roomGroupIndex: 0, quantity: 1 },
            { date: '2026-09-20', roomType: 'DLX', ratePlan: 'BAR2', available: 1, amount: '900.00', currency: 'ZAR', restrictions: ['none'], roomGroupIndex: 1, quantity: 1 },
            { date: '2026-09-21', roomType: 'STD', ratePlan: 'BAR', available: 2, amount: '1200.00', currency: 'ZAR', restrictions: ['none'], roomGroupIndex: 0, quantity: 1 },
            { date: '2026-09-21', roomType: 'DLX', ratePlan: 'BAR2', available: 1, amount: '900.00', currency: 'ZAR', restrictions: ['none'], roomGroupIndex: 1, quantity: 1 },
          ],
        },
      }),
      req,
      manifest,
      new Date('2026-09-16T00:00:00.000Z'),
    );
    expect(parsed.envelopeRecognized).toBe(true);
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.unresolvedFields).not.toContain('room_group_correlation_unresolved');
    expect(parsed.occupancyPriced).toBe(true);
    const data = buildHotelAvailabilityReadData({ request: req, parsed });
    expect(data.nightlyObservations).toHaveLength(4);
    expect(data.stayTotal).toMatchObject({ amount: '4200.00', currency: 'ZAR' });
    expect(data.displayRateSum?.amount).toBe('4200.00');
  });

  it('fails closed when mixed-room group identity is absent', () => {
    const req = request();
    const parsed = parseHotelAvailabilityResponse(
      JSON.stringify({
        result: {
          success: true,
          rows: [
            { date: '2026-09-20', roomType: 'STD', ratePlan: 'BAR', available: 2, amount: '1200.00', currency: 'ZAR', restrictions: ['none'] },
            { date: '2026-09-20', roomType: 'DLX', ratePlan: 'BAR2', available: 1, amount: '900.00', currency: 'ZAR', restrictions: ['none'] },
          ],
        },
      }),
      req,
      manifest,
      new Date('2026-09-16T00:00:00.000Z'),
    );
    expect(parsed.unresolvedFields).toContain('room_group_correlation_unresolved');
  });

  it('supports discovered array paths instead of silently dropping valid rows', () => {
    const req = request();
    const arrayPathManifest = hotelAvailabilitySurfaceManifestSchema.parse({
      ...manifest,
      response: {
        ...manifest.response,
        amountPath: 'pricing[0].amount',
      },
    });
    const parsed = parseHotelAvailabilityResponse(
      JSON.stringify({
        result: {
          success: true,
          occupancyPriced: true,
          stayTotal: '2100.00',
          rows: [
            {
              date: '2026-09-20',
              roomType: 'STD',
              ratePlan: 'BAR',
              available: 2,
              pricing: [{ amount: '1050.00' }],
              currency: 'ZAR',
              restrictions: ['none'],
            },
          ],
        },
      }),
      req,
      arrayPathManifest,
      new Date('2026-09-16T00:00:00.000Z'),
    );
    expect(parsed.rows[0]?.displayedAmount).toBe('1050.00');
    expect(parsed.unresolvedFields).not.toContain('hotel_availability.row.0.displayedAmount');
  });

  it('rejects guessed/write surfaces at manifest validation', () => {
    expect(() =>
      hotelAvailabilitySurfaceManifestSchema.parse({
        ...manifest,
        searchPath: '/web/base/OSMPAV.reserve',
      }),
    ).toThrow();
  });

  it('includes only the minimal authenticated shell and never OSRRAV', () => {
    const policy = buildHotelAvailabilityRequestManifest({
      origin: 'https://hms.example.test',
      request: request(),
      surface: manifest,
    });
    const paths = policy.rules.map((rule) => rule.path);
    expect(paths).toContain('/web/base/logindisp');
    expect(paths).toContain('/web/base/login');
    expect(paths).toContain('/web/base/COMMON');
    expect(paths).toContain('/web/base/OSRESV');
    expect(paths).toContain(manifest.searchPath);
    expect(paths).not.toContain('/web/base/OSRRAV.HDR.search');
    expect(paths.some((path) => /reserve|save|submit|cancel/i.test(path))).toBe(false);
  });
});
