import {
  staffQuoteInput,
  prepareStaffQuote,
  executeStaffQuote,
  attestStaffQuote,
} from '../src/ai/staff-quote-workflow.js';
import { createReservationistBusinessServices } from '../src/ai/reservationist-business-services.js';
import { quoteDigest, occupiedDates } from '../src/quote-proposal/quote-revision.js';
import { resolveLedgerProposal } from '../src/trpc/routes/workstation.js';
import { describe, it, expect, vi, afterEach } from 'vitest';

const scope = {
  transportId: 'transport',
  userId: 'staff',
  threadId: 'thread',
  messageId: 'message',
  sourceHash: 'a'.repeat(64),
  propertyCode: 'HRCEN',
  messageAt: '2026-09-30T12:00:00Z',
  messageText: 'Original email with incomplete occupancy and a shuttle question',
};
const input = () =>
  staffQuoteInput.parse({
    messageId: scope.messageId,
    sourceHash: scope.sourceHash,
    selectionEpoch: 3,
    inputRevision: 2,
    groups: [
      {
        id: 'single',
        arrivalDate: '2026-10-12',
        departureDate: '2026-10-15',
        quantity: 2,
        adults: 1,
        childrenAges: [],
        board: 'room_only',
        roomCodes: ['SKNG'],
      },
    ],
  });
async function fixture() {
  const confirmed = input(),
    prepared = prepareStaffQuote(
      confirmed,
      scope,
      { signerName: 'Staff', signerEmail: 'staff@example.test' },
      new AbortController().signal,
    ),
    calls: any[] = [];
  const options = {
    authorizationId: prepared.authorizationId,
    authorizeContext: async () => true,
    signer: { signerName: 'Staff', signerEmail: 'staff@example.test' },
    readQuote: async (request: any) => {
      calls.push(structuredClone(request));
      const normalize = await import('../tooling/playwright-quote/quote-contract.mjs' as string),
        normalized = normalize.normalizeQuoteRequest({ schemaVersion: 2, ...request }).request;
      return {
        ref: 'source:' + calls.length,
        sha256: 'b'.repeat(64),
        toolVersion: 'fixture',
        observedAt: new Date().toISOString(),
        request: normalized,
        result: {
          outcome: 'quote',
          propertyCode: 'HRCEN',
          groups: normalized.rooms.map((r: any) => ({
            id: r.id,
            request: r,
            completeness: { search: 'complete', requiredFacts: 'complete' },
            options: [
              {
                id: 'option',
                room: { code: 'SKNG', label: 'Standard King', buildingCode: 'MAIN' },
                rate: { code: 'BARRO', label: 'Room Only' },
                board: 'Room Only R',
                appliedContext: {},
                eligibility: 'verified',
                availability: 'available',
                matchStatus: 'match',
                held: false,
                totals: { taxInclusive: true },
                nightly: occupiedDates(normalized.arrivalDate, normalized.departureDate).map(
                  (date, i) => ({
                    date,
                    inventory: 8,
                    price: {
                      amount: ['100.01', '500.00', '500.00'][i] ?? '500.00',
                      currency: 'ZAR',
                    },
                  }),
                ),
              },
            ],
          })),
        },
      };
    },
    resolvePolicy: async () => ({
      ref: 'policy',
      propertyCode: 'HRCEN',
      sourceHashes: ['c'.repeat(64)],
      authoredDates: ['2026-09-08'],
      families: [{ rateCode: 'BARRO', board: 'room_only' as const }],
      vat: 'included' as const,
      levy: 'included' as const,
    }),
  };
  return { confirmed, prepared, calls, options };
}
afterEach(() => vi.useRealTimers());
describe('staff-approved quotation beneath native guards', () => {
  it('uses exact corrections without manufacturing extracted facts; varies nightly prices and multiplies quantity once', async () => {
    const f = await fixture(),
      services = createReservationistBusinessServices(f.options, f.prepared.approval),
      revision = await executeStaffQuote(f.prepared, services, async () => true);
    expect(f.prepared.context.facts).toEqual([]);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]).toMatchObject({
      arrivalDate: '2026-10-12',
      departureDate: '2026-10-15',
      rooms: [{ quantity: 2, adults: 1 }],
    });
    expect(revision.totalMinor).toBe(220002);
    const attestation = attestStaffQuote(f.confirmed, scope, f.prepared, revision),
      run = {
        transportId: scope.transportId,
        triggerMessageId: scope.messageId,
        state: 'succeeded',
        metrics: {
          staffQuoteAttestation: attestation,
          reservationistResult: {
            readiness: 'needs_clarification',
            tasks: [{ id: 'shuttle', status: 'blocked' }],
            quoteRevisionIds: [revision.id],
            quoteRevisions: [revision],
          },
        },
      };
    const selected = {
      transportId: scope.transportId,
      messageId: scope.messageId,
      revisionRef: revision.id,
      factRefs: [],
    };
    expect(resolveLedgerProposal(run, selected).revision.id).toBe(revision.id);
    expect(() =>
      resolveLedgerProposal(
        {
          ...run,
          metrics: {
            ...run.metrics,
            staffQuoteAttestation: { ...attestation, authorizationId: 'wrong' },
          },
        },
        selected,
      ),
    ).toThrow('proposal_not_ready');
  });
  it('rejects client prices, mismatched source, duplicate groups and unsupported combined stays', () => {
    expect(() => staffQuoteInput.parse({ ...input(), rate: 1700 })).toThrow();
    expect(() =>
      prepareStaffQuote(
        input(),
        { ...scope, transportId: '' },
        { signerName: '', signerEmail: '' },
        new AbortController().signal,
      ),
    ).toThrow('source_changed');
    const v = input();
    v.groups.push({ ...v.groups[0] });
    expect(() =>
      prepareStaffQuote(
        v,
        scope,
        { signerName: '', signerEmail: '' },
        new AbortController().signal,
      ),
    ).toThrow('duplicate_group');
    v.groups[1].id = 'another';
    v.groups[1].arrivalDate = '2026-10-13';
    expect(() =>
      prepareStaffQuote(
        v,
        scope,
        { signerName: '', signerEmail: '' },
        new AbortController().signal,
      ),
    ).toThrow('separate_stay');
  });
  it('rechecks source and refuses a changed approval or missing party service', async () => {
    const f = await fixture();
    await expect(
      executeStaffQuote(
        f.prepared,
        createReservationistBusinessServices(f.options, f.prepared.approval),
        async () => false,
      ),
    ).rejects.toThrow('source_changed');
    expect(f.calls).toHaveLength(0);
    const services = createReservationistBusinessServices(f.options, f.prepared.approval);
    f.prepared.request.rooms[0].adults = 2;
    await expect(executeStaffQuote(f.prepared, services, async () => true)).rejects.toThrow(
      'approval_changed',
    );
    const other = await fixture();
    other.prepared.header.company = 'Company';
    await expect(
      executeStaffQuote(
        other.prepared,
        createReservationistBusinessServices(other.options, other.prepared.approval),
        async () => true,
      ),
    ).rejects.toThrow('party_lookup');
  });
  it('zero-priced native rooms cannot become a qualified quote', async () => {
    const f = await fixture(),
      original = f.options.readQuote;
    f.options.readQuote = async (r) => {
      const source = await original(r);
      source.result.groups[0].options[0].nightly[0].price.amount = '0.00';
      return source;
    };
    await expect(
      executeStaffQuote(
        f.prepared,
        createReservationistBusinessServices(f.options, f.prepared.approval),
        async () => true,
      ),
    ).rejects.toThrow('selected_price');
  });
});
