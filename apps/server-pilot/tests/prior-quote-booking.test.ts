import { afterEach, describe, expect, it } from 'vitest';
import {
  analysisMatchesQuotedStay,
  collectThreadQuoteRevisions,
  priorStaffQuoteRequotePayload,
  proposalFactRefsForRevision,
  resolvePriorQuoteForBooking,
  revisionCarriesOnceExtras,
} from '../src/ai/prior-quote-booking.js';
import type { LunaAnalysis } from '../src/ai/reservationist-decision.js';
import { buildStaffProposalFacts, staffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import { occupiedDates } from '../src/quote-proposal/quote-revision.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { appRouter } from '../src/trpc/router.js';
import {
  listThreadQuoteRevisionsInput,
  usePriorQuoteForBookingInput,
} from '../src/trpc/routes/workstation.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';

function analysis(over: Partial<LunaAnalysis> = {}): LunaAnalysis {
  return {
    workflow: 'create_booking',
    flags: [],
    groups: [
      {
        arrival: '2026-10-12',
        departure: '2026-10-13',
        rooms: 2,
        adultsPerRoom: 1,
        childAges: [],
        board: 'room_only',
        roomPreference: null,
        guestNames: ['Mr John Smith'],
      },
    ],
    party: { kind: 'agency', name: 'XYZ TRAVEL', reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [],
    ...over,
  };
}

async function freshRevision() {
  const revision = structuredClone(
    await syntheticRevision(['1850.00'], 'Room Only R', 'STQN', '2026-10-07T02:50:00Z'),
  );
  revision.groups[0]!.rateCode = 'TAXYZ';
  revision.groups[0]!.context = { agency: { nativeId: '455', name: 'XYZ TRAVEL' } };
  return revision;
}

describe('collectThreadQuoteRevisions', () => {
  it('returns the newest matching thread revision and ignores other transports', async () => {
    const revision = await freshRevision();
    const listed = collectThreadQuoteRevisions(
      [
        {
          id: 'run-old',
          transportId: 't1',
          threadId: 'thread-1',
          state: 'succeeded',
          createdAt: '2026-10-06T10:00:00Z',
          finishedAt: '2026-10-06T10:01:00Z',
          metrics: {
            reservationistResult: {
              quoteRevisionIds: [revision.id],
              quoteRevisions: [revision],
            },
          },
        },
        {
          id: 'run-new',
          transportId: 't1',
          threadId: 'thread-1',
          state: 'succeeded',
          createdAt: '2026-10-06T12:00:00Z',
          finishedAt: '2026-10-06T12:01:00Z',
          metrics: {
            reservationistResult: {
              quoteRevisionIds: ['rev-new'],
              quoteRevisions: [{ ...revision, id: 'rev-new', groups: revision.groups }],
            },
          },
        },
        {
          id: 'run-other',
          transportId: 't-other',
          threadId: 'thread-1',
          state: 'succeeded',
          createdAt: '2026-10-06T13:00:00Z',
          finishedAt: '2026-10-06T13:01:00Z',
          metrics: {
            reservationistResult: {
              quoteRevisionIds: [revision.id],
              quoteRevisions: [revision],
            },
          },
        },
      ],
      { transportId: 't1', threadId: 'thread-1' },
    );
    expect(listed[0]).toMatchObject({
      workflowRunId: 'run-new',
      revisionRef: 'rev-new',
      roomCodes: ['STQN'],
      rateCodes: ['TAXYZ'],
      partyName: 'XYZ TRAVEL',
    });
    expect(listed).toHaveLength(2);
  });
});

describe('analysisMatchesQuotedStay', () => {
  it('rejects a booking whose dates are not on the quoted stay', async () => {
    const revision = await freshRevision();
    expect(analysisMatchesQuotedStay(analysis(), revision)).toBe(true);
    expect(
      analysisMatchesQuotedStay(
        analysis({
          groups: [{ ...analysis().groups[0]!, arrival: '2026-12-01', departure: '2026-12-03' }],
        }),
        revision,
      ),
    ).toBe(false);
  });

  it('rejects a booking whose room count differs from the quoted stay', async () => {
    const revision = await freshRevision();
    expect(
      analysisMatchesQuotedStay(
        analysis({
          groups: [{ ...analysis().groups[0]!, rooms: 1 }],
        }),
        revision,
      ),
    ).toBe(false);
  });

  it('rejects a booking whose occupancy differs from the quoted stay', async () => {
    const revision = await freshRevision();
    expect(
      analysisMatchesQuotedStay(
        analysis({
          groups: [{ ...analysis().groups[0]!, adultsPerRoom: 2 }],
        }),
        revision,
      ),
    ).toBe(false);
  });
});

describe('priorStaffQuoteRequotePayload', () => {
  it('returns stored groups and party header from attestation', async () => {
    const revision = await freshRevision();
    revision.groups[0]!.childAges = [7];
    const payload = priorStaffQuoteRequotePayload(
      {
        transportId: 't1',
        threadId: 'thread-1',
        state: 'succeeded',
        metrics: {
          staffQuoteAttestation: {
            version: 1,
            kind: 'staff_approved_quote',
            transportId: 't1',
            userId: 'u1',
            threadId: 'thread-1',
            messageId: 'mail-1',
            sourceHash: 'a'.repeat(64),
            selectionEpoch: 1,
            inputRevision: 1,
            inputDigest: 'digest',
            authorizationId: 'auth',
            revisionIds: [revision.id],
            header: { company: 'Acme', agency: 'XYZ TRAVEL' },
            salesStrategy: 'BAR',
          },
          reservationistResult: {
            quoteRevisionIds: [revision.id],
            quoteRevisions: [revision],
          },
        },
      },
      revision.id,
    );
    expect(payload).toMatchObject({
      salesStrategy: 'BAR',
      company: 'Acme',
      agency: 'XYZ TRAVEL',
      groups: [
        expect.objectContaining({
          arrivalDate: revision.groups[0]!.arrivalDate,
          quantity: revision.groups[0]!.quantity,
          childrenAges: [7],
          roomCodes: [revision.groups[0]!.roomCode],
        }),
      ],
    });
  });

  it('restores stored dinner and shuttle extras onto the re-quote payload', async () => {
    const revision = await freshRevision();
    const payload = priorStaffQuoteRequotePayload(
      {
        transportId: 't1',
        threadId: 'thread-1',
        state: 'succeeded',
        metrics: {
          staffQuoteAttestation: {
            version: 1,
            kind: 'staff_approved_quote',
            transportId: 't1',
            userId: 'u1',
            threadId: 'thread-1',
            messageId: 'mail-1',
            sourceHash: 'a'.repeat(64),
            selectionEpoch: 1,
            inputRevision: 1,
            inputDigest: 'digest',
            authorizationId: 'auth',
            revisionIds: [revision.id],
            header: { company: 'Acme', agency: 'XYZ TRAVEL' },
            salesStrategy: 'BAR',
          },
          reservationistResult: {
            quoteRevisionIds: [revision.id],
            quoteRevisions: [revision],
            proposalFacts: [
              {
                ref: 'extras',
                facts: {
                  revisionId: revision.id,
                  authorizationId: revision.authorizationId,
                  sourceRef: 'message:mail-1',
                  sourceHash: 'ab'.repeat(32),
                  extras: [
                    {
                      id: 'dinner-allowance',
                      label: 'Dinner allowance',
                      quantity: 1,
                      units: 2,
                      unitKind: 'person_service',
                      unitMinor: 12_500,
                      service: 'dinner_allowance',
                      persons: [],
                      dates: [],
                    },
                    {
                      id: 'shuttle',
                      label: 'Shuttle',
                      quantity: 1,
                      units: 1,
                      unitKind: 'trip',
                      unitMinor: 45_000,
                      service: 'shuttle',
                      persons: [],
                      dates: [revision.groups[0]!.arrivalDate],
                    },
                  ],
                  includedEntitlements: [],
                },
              },
            ],
          },
        },
      },
      revision.id,
    );
    expect(payload).toMatchObject({
      dinnerAllowanceMinor: 12_500,
      shuttleRequested: true,
      shuttleMinor: 45_000,
    });
  });

  it('restores the chosen unit of an other charge on a re-quote, including a one-night per-guest-per-night charge', async () => {
    const revision = await syntheticRevision();
    const sourceHash = 'a'.repeat(64);
    const input = staffQuoteInput.parse({
      messageId: 'mail-1',
      sourceHash,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [
        { id: 'g1', arrivalDate: '2026-10-12', departureDate: '2026-10-13', quantity: 1, adults: 2, childrenAges: [], board: 'bb' },
      ],
      other: { label: 'Laundry', amountMinor: 10_000, unit: 'per_person_night' },
    });
    const scope = { messageId: 'mail-1', sourceHash };
    const built = buildStaffProposalFacts(input, scope, { authorizationId: revision.authorizationId }, revision);
    const run = {
      transportId: 't1',
      threadId: 'thread-1',
      state: 'succeeded',
      metrics: {
        staffQuoteAttestation: {
          version: 1,
          kind: 'staff_approved_quote',
          transportId: 't1',
          userId: 'u1',
          threadId: 'thread-1',
          messageId: 'mail-1',
          sourceHash,
          selectionEpoch: 1,
          inputRevision: 1,
          inputDigest: 'digest',
          authorizationId: revision.authorizationId,
          revisionIds: [revision.id],
          header: { company: 'Acme', agency: 'XYZ TRAVEL' },
          salesStrategy: 'BAR',
        },
        reservationistResult: {
          quoteRevisionIds: [revision.id],
          quoteRevisions: [revision],
          proposalFacts: [{ ref: 'extras', facts: built.facts }],
        },
      },
    };
    const payload = priorStaffQuoteRequotePayload(run as never, revision.id);
    expect(payload?.other).toEqual({ label: 'Laundry', amountMinor: 10_000, unit: 'per_person_night' });
    // Re-quoting from that payload charges the same unit: 2 guests x 1 night.
    const again = buildStaffProposalFacts(
      staffQuoteInput.parse({ ...input, other: payload!.other }),
      scope,
      { authorizationId: revision.authorizationId },
      revision,
    );
    expect(again.facts?.extras[0]).toMatchObject({ chargeUnit: 'per_person_night', units: 2, dates: ['2026-10-12'] });
  });

  it('restores office transfer days only when staff typed them, so defaulted days follow the new stay', async () => {
    const revision = await freshRevision();
    const stay = revision.groups[0]!;
    const stayNights = occupiedDates(stay.arrivalDate, stay.departureDate);
    const typedDays = (count: number) => Array.from({ length: count }, (_, index) => `2026-10-${12 + index}`);
    const payloadWithOffice = (dates: string[], extra: Record<string, unknown>) =>
      priorStaffQuoteRequotePayload(
        {
          transportId: 't1',
          threadId: 'thread-1',
          state: 'succeeded',
          metrics: {
            staffQuoteAttestation: {
              version: 1,
              kind: 'staff_approved_quote',
              transportId: 't1',
              userId: 'u1',
              threadId: 'thread-1',
              messageId: 'mail-1',
              sourceHash: 'a'.repeat(64),
              selectionEpoch: 1,
              inputRevision: 1,
              inputDigest: 'digest',
              authorizationId: revision.authorizationId,
              revisionIds: [revision.id],
              header: { company: 'Acme', agency: 'XYZ TRAVEL' },
              salesStrategy: 'BAR',
            },
            reservationistResult: {
              quoteRevisionIds: [revision.id],
              quoteRevisions: [revision],
              proposalFacts: [
                {
                  ref: 'extras',
                  facts: {
                    revisionId: revision.id,
                    authorizationId: revision.authorizationId,
                    sourceRef: 'message:mail-1',
                    sourceHash: 'ab'.repeat(32),
                    extras: [
                      {
                        id: 'office-transfer',
                        label: 'Office transfer',
                        quantity: 1,
                        units: 2 * dates.length,
                        unitKind: 'person_service',
                        unitMinor: 20_000,
                        service: 'office_transfer',
                        persons: [],
                        dates,
                        ...extra,
                      },
                    ],
                    includedEntitlements: [],
                  },
                },
              ],
            },
          },
        },
        revision.id,
      );
    // Days left blank are stored as the stay's nights and flagged as defaulted, so they are not restored.
    const defaulted = payloadWithOffice(stayNights, { daysExplicit: false });
    expect(defaulted).toMatchObject({ officeTransferMinor: 20_000 });
    expect(defaulted).not.toHaveProperty('officeTransferDays');
    // Typed days are restored, including when they happen to equal the stay's nights.
    expect(payloadWithOffice(stayNights, { daysExplicit: true })).toMatchObject({
      officeTransferDays: stayNights.length,
    });
    expect(payloadWithOffice(typedDays(4), { daysExplicit: true })).toMatchObject({ officeTransferDays: 4 });
    // Facts stored before the flag: dates that differ from the stay's nights were typed.
    expect(payloadWithOffice(typedDays(stayNights.length + 1), {})).toMatchObject({
      officeTransferDays: stayNights.length + 1,
    });
    expect(payloadWithOffice(stayNights, {})).toMatchObject({ officeTransferMinor: 20_000 });
    expect(payloadWithOffice(stayNights, {})).not.toHaveProperty('officeTransferDays');
  });

  it('re-quotes a defaulted office transfer over the new stay length', async () => {
    // An unmutated synthetic revision keeps its digest id, which the builder checks (freshRevision edits it).
    const revision = await syntheticRevision(['1850.00']);
    const sourceHash = 'a'.repeat(64);
    const scope = { messageId: 'mail-1', sourceHash };
    const prepared = { authorizationId: revision.authorizationId };
    const input = (departureDate: string, officeTransferDays?: number) =>
      staffQuoteInput.parse({
        messageId: 'mail-1',
        sourceHash,
        selectionEpoch: 1,
        inputRevision: 1,
        groups: [
          { id: 'g1', arrivalDate: '2026-10-12', departureDate, quantity: 1, adults: 2, childrenAges: [], board: 'bb' },
        ],
        officeTransferMinor: 20_000,
        ...(officeTransferDays === undefined ? {} : { officeTransferDays }),
      });
    const stored = buildStaffProposalFacts(input('2026-10-13'), scope, prepared, revision);
    const payload = priorStaffQuoteRequotePayload(
      {
        transportId: 't1',
        threadId: 'thread-1',
        state: 'succeeded',
        metrics: {
          staffQuoteAttestation: {
            version: 1,
            kind: 'staff_approved_quote',
            transportId: 't1',
            userId: 'u1',
            threadId: 'thread-1',
            messageId: 'mail-1',
            sourceHash,
            selectionEpoch: 1,
            inputRevision: 1,
            inputDigest: 'digest',
            authorizationId: revision.authorizationId,
            revisionIds: [revision.id],
            header: { company: 'Acme', agency: 'XYZ TRAVEL' },
            salesStrategy: 'BAR',
          },
          reservationistResult: {
            quoteRevisionIds: [revision.id],
            quoteRevisions: [revision],
            proposalFacts: [{ ref: 'extras', facts: stored.facts }],
          },
        },
      },
      revision.id,
    );
    expect(payload).toMatchObject({ officeTransferMinor: 20_000 });
    expect(payload).not.toHaveProperty('officeTransferDays');
    // The three-night re-quote charges three days, not the one night that was stored.
    const again = buildStaffProposalFacts(input('2026-10-15', payload?.officeTransferDays), scope, prepared, revision);
    expect(again.facts?.extras[0]?.dates).toHaveLength(3);
  });

  it('returns saved extras bundle refs for the matching revision', async () => {
    const revision = await freshRevision();
    const run = {
      transportId: 't1',
      threadId: 'thread-1',
      state: 'succeeded',
      metrics: {
        reservationistResult: {
          quoteRevisionIds: [revision.id],
          quoteRevisions: [revision],
          proposalFacts: [
            {
              ref: 'extras-dinner',
              facts: {
                revisionId: revision.id,
                authorizationId: revision.authorizationId,
                sourceRef: 'message:mail-1',
                sourceHash: 'ab'.repeat(32),
                extras: [],
                includedEntitlements: [],
              },
            },
            {
              ref: 'extras-other',
              facts: {
                revisionId: 'rev-other',
                authorizationId: revision.authorizationId,
                sourceRef: 'message:mail-1',
                sourceHash: 'ab'.repeat(32),
                extras: [],
                includedEntitlements: [],
              },
            },
          ],
        },
      },
    };
    expect(proposalFactRefsForRevision(run, revision.id)).toEqual(['extras-dinner']);
    expect(proposalFactRefsForRevision(run, 'missing')).toEqual([]);
  });
});

describe('revisionCarriesOnceExtras', () => {
  function runWith(revisionId: string, extras: Array<Record<string, unknown>>) {
    return {
      transportId: 't1',
      threadId: 'thread-1',
      state: 'succeeded' as const,
      metrics: { reservationistResult: { proposalFacts: [{ ref: 'extras', facts: { revisionId, extras } }] } },
    };
  }
  const extra = (service: string, unitKind: string, chargeUnit?: string) => ({
    id: service,
    label: service,
    quantity: 1,
    units: 1,
    unitKind,
    unitMinor: 10_000,
    service,
    persons: [],
    dates: [],
    ...(chargeUnit ? { chargeUnit } : {}),
  });

  it('says a reused quote has its once-per-quote charges only when its stored facts do', () => {
    expect(revisionCarriesOnceExtras(runWith('rev-1', [extra('shuttle', 'trip')]) as never, 'rev-1')).toBe(true);
    expect(revisionCarriesOnceExtras(runWith('rev-1', [extra('other', 'item', 'item')]) as never, 'rev-1')).toBe(true);
    expect(
      revisionCarriesOnceExtras(runWith('rev-1', [extra('dinner_allowance', 'person_service')]) as never, 'rev-1'),
    ).toBe(false);
    expect(revisionCarriesOnceExtras(runWith('rev-1', [extra('shuttle', 'trip')]) as never, 'rev-2')).toBe(false);
  });
});

describe('resolvePriorQuoteForBooking', () => {
  it('returns ready when the thread run is fresh and dates match', async () => {
    const revision = await freshRevision();
    const resolved = resolvePriorQuoteForBooking(
      {
        transportId: 't1',
        threadId: 'thread-1',
        state: 'succeeded',
        metrics: {
          reservationistResult: {
            readiness: 'ready_for_staff_review',
            quoteRevisionIds: [revision.id],
            quoteRevisions: [revision],
          },
        },
      },
      {
        transportId: 't1',
        threadId: 'thread-1',
        revisionRef: revision.id,
        analysis: analysis(),
        now: new Date('2026-10-07T03:00:00Z'),
      },
    );
    expect(resolved).toMatchObject({ status: 'ready' });
    if (resolved.status === 'ready') {
      expect(resolved.revision.groups[0]!.roomCode).toBe('STQN');
      expect(resolved.revision.groups[0]!.rateCode).toBe('TAXYZ');
    }
  });

  it('returns expired when the authored window has lapsed', async () => {
    const revision = await freshRevision();
    revision.authoredDate = '2026-09-01';
    const resolved = resolvePriorQuoteForBooking(
      {
        transportId: 't1',
        threadId: 'thread-1',
        state: 'succeeded',
        metrics: {
          reservationistResult: {
            readiness: 'ready_for_staff_review',
            quoteRevisionIds: [revision.id],
            quoteRevisions: [revision],
          },
        },
      },
      {
        transportId: 't1',
        threadId: 'thread-1',
        revisionRef: revision.id,
        analysis: analysis(),
        now: new Date('2026-10-07T03:00:00Z'),
      },
    );
    expect(resolved).toEqual({ status: 'unavailable', reason: 'expired' });
  });

  it('returns not_found for another transport', async () => {
    const revision = await freshRevision();
    const resolved = resolvePriorQuoteForBooking(
      {
        transportId: 't1',
        threadId: 'thread-1',
        state: 'succeeded',
        metrics: {
          reservationistResult: {
            quoteRevisionIds: [revision.id],
            quoteRevisions: [revision],
          },
        },
      },
      {
        transportId: 'other',
        threadId: 'thread-1',
        revisionRef: revision.id,
        analysis: analysis(),
        now: new Date('2026-10-07T03:00:00Z'),
      },
    );
    expect(resolved).toEqual({ status: 'unavailable', reason: 'not_found' });
  });

  it('returns scope_mismatch when booking dates disagree with the quote', async () => {
    const revision = await freshRevision();
    const resolved = resolvePriorQuoteForBooking(
      {
        transportId: 't1',
        threadId: 'thread-1',
        state: 'succeeded',
        metrics: {
          reservationistResult: {
            readiness: 'ready_for_staff_review',
            quoteRevisionIds: [revision.id],
            quoteRevisions: [revision],
          },
        },
      },
      {
        transportId: 't1',
        threadId: 'thread-1',
        revisionRef: revision.id,
        analysis: analysis({
          groups: [{ ...analysis().groups[0]!, arrival: '2026-12-01', departure: '2026-12-03' }],
        }),
        now: new Date('2026-10-07T03:00:00Z'),
      },
    );
    expect(resolved).toEqual({ status: 'unavailable', reason: 'scope_mismatch' });
  });

  it('returns scope_mismatch for an expired revision whose stay does not match', async () => {
    const revision = await freshRevision();
    revision.authoredDate = '2026-09-01';
    const resolved = resolvePriorQuoteForBooking(
      {
        transportId: 't1',
        threadId: 'thread-1',
        state: 'succeeded',
        metrics: {
          reservationistResult: {
            quoteRevisionIds: [revision.id],
            quoteRevisions: [revision],
          },
        },
      },
      {
        transportId: 't1',
        threadId: 'thread-1',
        revisionRef: revision.id,
        analysis: analysis({
          groups: [{ ...analysis().groups[0]!, arrival: '2026-12-01', departure: '2026-12-03' }],
        }),
        now: new Date('2026-10-07T03:00:00Z'),
      },
    );
    expect(resolved).toEqual({ status: 'unavailable', reason: 'scope_mismatch' });
  });
});

function emptyListDb(): DB {
  const limit = async () => [];
  const orderBy = () => ({ limit });
  const where = () => ({ orderBy, limit });
  const from = () => ({ where });
  return { select: () => ({ from }) } as unknown as DB;
}

function caller(transportId = 'transport-centurion') {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers({ 'x-zero-active-transport': transportId }),
    sessionUser: { id: 'user-ropperman', email: 'staff@example.invalid', name: 'Staff' },
    activeTransportId: transportId,
    accessRole: 'owner',
    transportEmail: 'centurion@legacyhotels.co.za',
  } as never);
}

afterEach(() => {
  __setDbForTests(null);
});

describe('prior-quote routes', () => {
  it('rejects an extra list input key', () => {
    expect(() => listThreadQuoteRevisionsInput.parse({ threadId: 'thread-1', extra: true })).toThrow();
  });

  it('rejects an extra usePriorQuoteForBooking input key', () => {
    expect(() =>
      usePriorQuoteForBookingInput.parse({
        workflowRunId: 'run-1',
        revisionRef: 'rev-1',
        threadId: 'thread-1',
        messageId: 'message-1',
        selectionEpoch: 1,
        inputRevision: 1,
        analysis: analysis(),
        extra: true,
      }),
    ).toThrow();
  });

  it('returns not_found when the prior quote run is missing', async () => {
    __setDbForTests({ db: emptyListDb(), conn: null as never });
    const result = await caller().workstation.usePriorQuoteForBooking({
      workflowRunId: 'missing',
      revisionRef: 'rev-1',
      threadId: 'thread-1',
      messageId: 'message-1',
      selectionEpoch: 1,
      inputRevision: 1,
      analysis: analysis(),
    });
    expect(result).toEqual({ status: 'unavailable', reason: 'not_found' });
  });

  it('carries every staff extra and the note into a requote, and reads legacy dinner and shuttle rows', async () => {
    const revision = await freshRevision();
    const payloadFor = (extras: unknown[], notes?: string) =>
      priorStaffQuoteRequotePayload(
        {
          transportId: 't1',
          threadId: 'thread-1',
          state: 'succeeded',
          metrics: {
            staffQuoteAttestation: {
              version: 1,
              kind: 'staff_approved_quote',
              transportId: 't1',
              userId: 'u1',
              threadId: 'thread-1',
              messageId: 'mail-1',
              sourceHash: 'a'.repeat(64),
              selectionEpoch: 1,
              inputRevision: 1,
              inputDigest: 'digest',
              authorizationId: 'auth',
              revisionIds: [revision.id],
              header: { company: 'Acme', agency: 'XYZ TRAVEL' },
              salesStrategy: 'BAR',
              ...(notes ? { notes } : {}),
            },
            reservationistResult: {
              quoteRevisionIds: [revision.id],
              quoteRevisions: [revision],
              proposalFacts: [
                {
                  ref: 'extras',
                  facts: {
                    revisionId: revision.id,
                    authorizationId: revision.authorizationId,
                    sourceRef: 'message:mail-1',
                    sourceHash: 'ab'.repeat(32),
                    extras,
                    includedEntitlements: [],
                  },
                },
              ],
            },
          },
        } as never,
        revision.id,
      );
    const payload = payloadFor(
      [
        {
          id: 'dinner-allowance',
          label: 'Dinner allowance (food only)',
          quantity: 1,
          units: 6,
          unitKind: 'person_service',
          unitMinor: 45_000,
          service: 'dinner_allowance',
          persons: [],
          dates: [],
        },
        {
          id: 'lunch-allowance',
          label: 'Lunch allowance',
          quantity: 1,
          units: 6,
          unitKind: 'person_service',
          unitMinor: 20_000,
          service: 'lunch_allowance',
          persons: [],
          dates: [],
        },
        {
          id: 'office-transfer',
          label: 'Office transfer',
          quantity: 1,
          units: 4,
          unitKind: 'person_service',
          unitMinor: 20_000,
          service: 'office_transfer',
          persons: [],
          dates: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'],
        },
        {
          id: 'shuttle',
          label: 'Shuttle',
          quantity: 1,
          units: 2,
          unitKind: 'trip',
          unitMinor: 60_000,
          service: 'shuttle',
          persons: [],
          dates: ['2026-10-12'],
        },
        {
          id: 'other',
          label: 'Parking',
          quantity: 1,
          units: 1,
          unitKind: 'item',
          unitMinor: 30_000,
          service: 'other',
          persons: [],
          dates: ['2026-10-12'],
        },
      ],
      'Late check-in',
    );
    expect(payload).toMatchObject({
      dinnerAllowanceMinor: 45_000,
      dinnerAllowanceLabel: 'food only',
      lunchAllowanceMinor: 20_000,
      officeTransferMinor: 20_000,
      officeTransferDays: 4,
      shuttleRequested: true,
      shuttleMinor: 60_000,
      shuttleTrips: 2,
      other: { label: 'Parking', amountMinor: 30_000, unit: 'item' },
      notes: 'Late check-in',
    });
    const legacy = payloadFor([
      {
        id: 'dinner-allowance',
        label: 'Dinner allowance',
        quantity: 1,
        units: 6,
        unitKind: 'person_service',
        unitMinor: 12_500,
        service: 'dinner_allowance',
        persons: [],
        dates: [],
      },
    ]);
    expect(legacy).toMatchObject({ dinnerAllowanceMinor: 12_500 });
    expect(legacy).not.toHaveProperty('notes');
    expect(legacy).not.toHaveProperty('other');
  });
});
