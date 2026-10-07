import { afterEach, describe, expect, it } from 'vitest';
import {
  analysisMatchesQuotedStay,
  collectThreadQuoteRevisions,
  priorStaffQuoteRequotePayload,
  proposalFactRefsForRevision,
  resolvePriorQuoteForBooking,
} from '../src/ai/prior-quote-booking.js';
import type { LunaAnalysis } from '../src/ai/reservationist-decision.js';
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
});
