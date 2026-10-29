import { paneStayDigest } from '../../src/ai/pane-stay-save.js';
import { resolveQuoteRevision, type QuoteSourceRecord } from '../../src/quote-proposal/quote-revision.js';
import type { HmsCreatePlanInput } from '../../src/ai/hms-create-plan.js';

export const PLAN_NOW = new Date('2026-10-29T12:00:00.000Z');
export const PLAN_STAY = {
  firstName: 'Proof', lastName: 'Labtest', arrival: '2027-09-14', departure: '2027-09-16',
  adults: 2, childAges: [6], sourceOfBusiness: 'Walk in', roomType: 'STQN', ratePlan: 'BAR',
  track: 'BAR', guaranteeType: 'Awaiting Voucher', cmsMessageId: '01', propertyCode: 'HRCEN',
};

export async function quotedPlanFixture(): Promise<{ revision: Awaited<ReturnType<typeof resolveQuoteRevision>>; input: HmsCreatePlanInput }> {
  const room = { id: 'g1', quantity: 1, adults: 2, children: 1, childAges: [6] };
  const source: QuoteSourceRecord = {
    ref: 'source-1', sha256: 'a'.repeat(64), toolVersion: 'fixture', observedAt: '2026-10-29T11:59:00.000Z',
    request: { propertyCode: 'HRCEN', arrivalDate: PLAN_STAY.arrival, departureDate: PLAN_STAY.departure,
      rooms: [room], requestedCurrency: 'ZAR' },
    result: { outcome: 'quote', propertyCode: 'HRCEN', groups: [{ id: room.id, request: room,
      completeness: { search: 'complete', requiredFacts: 'complete' }, options: [{
        id: 'option-1', room: { code: 'STQN', label: 'Standard Queen', buildingCode: 'MAIN' },
        rate: { code: 'BAR', label: 'Best available' }, board: 'Room Only R', appliedContext: {},
        eligibility: 'verified', availability: 'available', matchStatus: 'match', held: false,
        totals: { taxInclusive: true }, nightly: [
          { date: '2027-09-14', inventory: 3, price: { amount: '100.01', currency: 'ZAR' } },
          { date: '2027-09-15', inventory: 3, price: { amount: '120.50', currency: 'ZAR' } },
        ],
      }] }] },
  };
  const revision = await resolveQuoteRevision({
    propertyCode: 'HRCEN', authoredDate: '2026-10-29',
    selections: [{ sourceRef: source.ref, groupId: 'g1', optionId: 'option-1' }],
    resolveSource: async () => source,
    resolvePolicy: async () => ({ ref: 'policy', propertyCode: 'HRCEN', sourceHashes: ['b'.repeat(64)],
      authoredDates: ['2026-10-01'], families: [{ rateCode: 'BAR', board: 'room_only' }], vat: 'included', levy: 'included' }),
    admission: { authorizationId: 'auth-1', sourceEvaluationAt: PLAN_NOW.toISOString(),
      maxSourceAgeMs: 60_000, expectedRequests: { [source.ref]: source.request }, authorizeSource: async () => true },
  });
  return { revision, input: { workItemId: '00000000-0000-4000-8000-000000000001', stayId: 'room1',
    quoteRunId: 'quote-run', revisionId: revision.id, groupId: 'g1', previewDigest: paneStayDigest(PLAN_STAY), stay: PLAN_STAY } };
}
