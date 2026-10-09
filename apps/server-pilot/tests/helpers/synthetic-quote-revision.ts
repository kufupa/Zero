import { resolveQuoteRevision, type QuoteSourceRecord } from '../../src/quote-proposal/quote-revision.js';
export async function syntheticRevision(amounts = ['100.01', '500.00', '500.00'], board = 'Room Only R', roomCode = 'SKNG', currentSourceAt?: string, arrival = '2026-10-12') {
 const req = { id: 'g1', quantity: 2, adults: 1, children: 0, childAges: [] };
 const start = arrival;
 const end = new Date(Date.parse(`${start}T00:00:00Z`) + amounts.length * 86400000).toISOString().slice(0, 10);
 const source: QuoteSourceRecord = { ref: 'synthetic', sha256: 'a'.repeat(64), toolVersion: '2', observedAt: currentSourceAt ?? '2026-10-04T09:00:00Z',
 request: { propertyCode: 'HRCEN', requestedCurrency: 'ZAR', arrivalDate: start, departureDate: end, rooms: [req] },
 result: { outcome: 'quote', propertyCode: 'HRCEN', groups: [{ id: 'g1', request: req, completeness: { search: 'complete', requiredFacts: 'complete' }, options: [{
 id: 'selected', room: { code: roomCode, label: 'Standard King', buildingCode: 'MAIN' }, rate: { code: 'BAR', label: 'Best Available' }, board, appliedContext: {}, eligibility: 'verified', availability: 'available', matchStatus: 'match', held: false, totals: { taxInclusive: true },
 nightly: amounts.map((amount, i) => ({ date: new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10), inventory: 5, price: { amount, currency: 'ZAR' } }))
 }] }] } };
 return resolveQuoteRevision({ admission: { authorizationId: 'synthetic-auth', sourceEvaluationAt: currentSourceAt ?? '2026-10-04T10:00:00Z', maxSourceAgeMs: 3600000, expectedRequests: { synthetic: source.request }, authorizeSource: async () => true }, propertyCode: 'HRCEN', authoredDate: currentSourceAt?.slice(0,10) ?? '2026-10-04', selections: [{ sourceRef: source.ref, groupId: 'g1', optionId: 'selected' }], resolveSource: async () => source,
 resolvePolicy: async () => ({ ref: 'synthetic-policy', propertyCode: 'HRCEN', sourceHashes: ['b'.repeat(64)], authoredDates: ['2026-09-26'], families: [{ rateCode: 'BAR', board: board === 'Room Only R' ? 'room_only' : 'breakfast' }], vat: 'included', levy: 'included' }) });
}
