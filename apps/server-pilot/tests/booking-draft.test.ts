import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildBookingDrafts,
  createRequestFieldOptions,
  requestFromQuotedRoom,
  splitGuestName,
} from '../src/ai/booking-draft.js';
import type { LunaAnalysis } from '../src/ai/reservationist-decision.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { appRouter } from '../src/trpc/router.js';
import { prepareBookingDraftInput } from '../src/trpc/routes/workstation.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';
import type { QuoteRevision } from '../src/quote-proposal/quote-revision.js';

const COMPLETE_DEFAULTS = {
  track: 'BAR',
  sourceOfBusiness: 'Travel Agent',
  guaranteeType: 'Guaranteed By Agent',
} as const;

const NULL_DEFAULTS = {
  track: null,
  sourceOfBusiness: null,
  guaranteeType: null,
};

async function validateCreate(request: Record<string, unknown>) {
  const mod = (await import(
    pathToFileURL(
      fileURLToPath(new URL('../tooling/playwright-quote/create-request.mjs', import.meta.url)),
    ).href
  )) as {
    loadCreateToolSchema(): Promise<unknown>;
    normalizeCreateLabels(data: unknown): unknown;
    validateCreateRequest(
      data: unknown,
      schema: unknown,
    ): { ok: boolean; errors: unknown[] };
  };
  return mod.validateCreateRequest(
    mod.normalizeCreateLabels(request),
    await mod.loadCreateToolSchema(),
  );
}

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
        guestNames: ['Mr John Smith', 'Jane Doe'],
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

async function agencyRevision(over?: {
  roomCode?: string;
  rateCode?: string;
  amounts?: string[];
  context?: Record<string, unknown>;
}): Promise<QuoteRevision> {
  const revision = structuredClone(
    await syntheticRevision(over?.amounts ?? ['1850.00'], 'Room Only R', over?.roomCode ?? 'STQN'),
  );
  const group = revision.groups[0]!;
  group.rateCode = over?.rateCode ?? 'TAXYZ';
  group.context = over?.context ?? {
    agency: { id: '17', code: 'TAXYZ', name: 'XYZ TRAVEL' },
  };
  return revision;
}

const draftInput = {
  workflowRunId: 'run-1',
  revisionRef: 'quote:abc',
  messageId: 'message-1',
  selectionEpoch: 1,
  inputRevision: 1,
  analysis: analysis(),
};

function emptySelectDb(): DB {
  const limit = async () => [];
  const where = () => ({ limit });
  const innerJoin = () => ({ where });
  const from = () => ({ innerJoin, where });
  return { select: () => ({ from }) } as unknown as DB;
}

function draftCaller(transportId = 'transport-centurion') {
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

describe('splitGuestName', () => {
  it('strips titles and dots, last token lastName, rest firstName', () => {
    expect(splitGuestName('Mr John Smith')).toEqual({ firstName: 'John', lastName: 'Smith' });
    expect(splitGuestName('Jane Doe')).toEqual({ firstName: 'Jane', lastName: 'Doe' });
    expect(splitGuestName('Dr. Jane A. Doe')).toEqual({ firstName: 'Jane A', lastName: 'Doe' });
    expect(splitGuestName('Miss Mary-Anne Cook')).toEqual({
      firstName: 'Mary-Anne',
      lastName: 'Cook',
    });
  });
});

describe('requestFromQuotedRoom', () => {
  it('omits null defaults and records missing questions', () => {
    const { request, missing } = requestFromQuotedRoom({
      arrival: '2026-10-12',
      departure: '2026-10-13',
      adults: 1,
      childAges: [],
      roomCode: 'STQN',
      rateCode: 'TAXYZ',
      party: { kind: 'agency', name: 'XYZ TRAVEL' },
      guestName: 'Mr John Smith',
      defaults: NULL_DEFAULTS,
    });
    expect(request).not.toHaveProperty('track');
    expect(request).not.toHaveProperty('sourceOfBusiness');
    expect(request).not.toHaveProperty('guaranteeType');
    expect(request).toMatchObject({
      arrival: '2026-10-12',
      departure: '2026-10-13',
      adults: 1,
      roomType: 'STQN',
      ratePlan: 'TAXYZ',
      agency: 'XYZ TRAVEL',
      firstName: 'John',
      lastName: 'Smith',
    });
    expect(missing).toEqual([
      { field: 'track', question: 'Track for this booking?' },
      { field: 'sourceOfBusiness', question: 'Source of business for this booking?' },
      { field: 'guaranteeType', question: 'Guarantee type for this booking?' },
    ]);
  });
});

describe('createRequestFieldOptions', () => {
  it('lists the room type codes the booking card selects from', () => {
    expect(createRequestFieldOptions().roomType).toEqual(expect.arrayContaining(['STQN', 'DLXKNG']));
  });
});

describe('buildBookingDrafts', () => {
  it('builds one request per quoted room with agency rate and split names', async () => {
    const revision = await agencyRevision();
    const draft = await buildBookingDrafts({
      analysis: analysis(),
      revision,
      defaults: COMPLETE_DEFAULTS,
      messageId: 'message-1',
      validate: validateCreate,
    });
    expect(draft.rooms).toHaveLength(2);
    expect(draft.rooms.map((room) => room.roomIndex)).toEqual([1, 2]);
    expect(draft.rooms[0]!.request).toMatchObject({
      agency: 'XYZ TRAVEL',
      ratePlan: 'TAXYZ',
      roomType: 'STQN',
      firstName: 'John',
      lastName: 'Smith',
      track: 'BAR',
      sourceOfBusiness: 'Travel Agent',
      guaranteeType: 'Guaranteed By Agent',
    });
    expect(draft.rooms[1]!.request).toMatchObject({
      agency: 'XYZ TRAVEL',
      ratePlan: 'TAXYZ',
      firstName: 'Jane',
      lastName: 'Doe',
    });
    expect(draft.rooms.every((room) => room.schemaErrors.length === 0)).toBe(true);
    expect(draft.missing).toEqual([]);
  });

  it('does not compare a second stay’s rate claim against a single quoted stay', async () => {
    const revision = await agencyRevision();
    const first = analysis().groups[0]!;
    const draft = await buildBookingDrafts({
      analysis: analysis({
        groups: [
          { ...first, arrival: '2026-10-12', departure: '2026-10-13' },
          { ...first, arrival: '2026-12-01', departure: '2026-12-03' },
        ],
        rateClaims: [
          {
            kind: 'exact',
            amount: '1850.00',
            currency: 'ZAR',
            basis: 'per_room_per_night',
            taxBasis: 'gross_included',
            quote: '1850.00',
          },
        ],
      }),
      revision,
      defaults: COMPLETE_DEFAULTS,
      messageId: 'message-1',
      validate: validateCreate,
    });
    expect(draft.rateCheck[0]).toMatchObject({ status: 'cannot_check', reason: 'ambiguous_stay' });
  });

  it.each([
    ['room_only', 'room_only'],
    ['breakfast', 'bb'],
    ['dinner_bed_breakfast', 'dinner_bb'],
  ] as const)(
    'gives each draft room the quoted %s board as %s, not the analysis board',
    async (quoted, expected) => {
      const revision = await agencyRevision();
      revision.groups[0]!.board = quoted;
      const draft = await buildBookingDrafts({
        analysis: analysis(),
        revision,
        defaults: COMPLETE_DEFAULTS,
        messageId: 'message-1',
        validate: validateCreate,
      });
      expect(draft.rooms.length).toBeGreaterThan(0);
      expect(draft.rooms.map((room) => room.board)).toEqual(draft.rooms.map(() => expected));
    },
  );

  it('assigns guest names from the luna group with the same stay dates, not array index', async () => {
    const revision = await agencyRevision();
    revision.groups[0]!.arrivalDate = '2026-12-01';
    revision.groups[0]!.departureDate = '2026-12-03';
    const first = analysis().groups[0]!;
    const draft = await buildBookingDrafts({
      analysis: analysis({
        groups: [
          { ...first, arrival: '2026-10-12', departure: '2026-10-13', guestNames: ['Wrong Person'] },
          { ...first, arrival: '2026-12-01', departure: '2026-12-03', guestNames: ['Right Guest'] },
        ],
      }),
      revision,
      defaults: COMPLETE_DEFAULTS,
      messageId: 'message-1',
      validate: validateCreate,
    });
    expect(draft.rooms[0]!.request).toMatchObject({ firstName: 'Right', lastName: 'Guest' });
  });

  it('marks a voucher ceiling below the quoted night as mismatch', async () => {
    const revision = await agencyRevision();
    const draft = await buildBookingDrafts({
      analysis: analysis({
        rateClaims: [
          {
            kind: 'ceiling',
            amount: 'R1,700',
            currency: 'ZAR',
            basis: 'per_room_per_night',
            taxBasis: 'gross_included',
            quote: 'R1,700',
          },
        ],
      }),
      revision,
      defaults: COMPLETE_DEFAULTS,
      messageId: 'message-1',
      validate: validateCreate,
    });
    expect(draft.rateCheck[0]).toMatchObject({
      status: 'mismatch',
      differenceMinor: -15000,
      claimQuote: 'R1,700',
      assumedTaxBasis: false,
    });
  });

  it('matches an exact nightly amount on every quoted night', async () => {
    const revision = await agencyRevision({ amounts: ['1850.00', '1850.00'] });
    const draft = await buildBookingDrafts({
      analysis: analysis({
        rateClaims: [
          {
            kind: 'exact',
            amount: '1850.00',
            currency: 'ZAR',
            basis: 'per_room_per_night',
            taxBasis: 'gross_included',
            quote: '1850.00',
          },
        ],
      }),
      revision,
      defaults: COMPLETE_DEFAULTS,
      messageId: 'message-1',
      validate: validateCreate,
    });
    expect(draft.rateCheck[0]).toMatchObject({ status: 'match', assumedTaxBasis: false });
  });

  it('cannot check an unknown basis', async () => {
    const revision = await agencyRevision();
    const draft = await buildBookingDrafts({
      analysis: analysis({
        rateClaims: [
          {
            kind: 'exact',
            amount: '1850.00',
            currency: 'ZAR',
            basis: 'unknown',
            taxBasis: 'gross_included',
            quote: '1850.00',
          },
        ],
      }),
      revision,
      defaults: COMPLETE_DEFAULTS,
      messageId: 'message-1',
      validate: validateCreate,
    });
    expect(draft.rateCheck[0]).toMatchObject({
      status: 'cannot_check',
      reason: 'ambiguous_basis',
    });
  });

  it('compares unknown taxBasis as VAT-inclusive and labels the assumption', async () => {
    const revision = await agencyRevision();
    const draft = await buildBookingDrafts({
      analysis: analysis({
        rateClaims: [
          {
            kind: 'exact',
            amount: '1850.00',
            currency: 'ZAR',
            basis: 'per_room_per_night',
            taxBasis: 'unknown',
            quote: '1850.00',
          },
        ],
      }),
      revision,
      defaults: COMPLETE_DEFAULTS,
      messageId: 'message-1',
      validate: validateCreate,
    });
    expect(draft.rateCheck[0]).toMatchObject({
      status: 'match',
      assumedTaxBasis: true,
    });
  });

  it('matches a guest total that includes stored extras while nightly stays room-only', async () => {
    const revision = await agencyRevision();
    const extra = 50_000;
    const amount = ((revision.totalMinor + extra) / 100).toFixed(2);
    const withExtras = await buildBookingDrafts({
      analysis: analysis({
        rateClaims: [
          {
            kind: 'total',
            amount,
            currency: 'ZAR',
            basis: 'total',
            taxBasis: 'gross_included',
            quote: amount,
          },
        ],
      }),
      revision,
      defaults: COMPLETE_DEFAULTS,
      messageId: 'message-1',
      extraTotalMinor: extra,
      validate: validateCreate,
    });
    expect(withExtras.rateCheck[0]).toMatchObject({ status: 'match' });
    const roomsOnly = await buildBookingDrafts({
      analysis: analysis({
        rateClaims: [
          {
            kind: 'total',
            amount,
            currency: 'ZAR',
            basis: 'total',
            taxBasis: 'gross_included',
            quote: amount,
          },
        ],
      }),
      revision,
      defaults: COMPLETE_DEFAULTS,
      messageId: 'message-1',
      extraTotalMinor: 0,
      validate: validateCreate,
    });
    expect(roomsOnly.rateCheck[0]?.status).toBe('mismatch');
  });

  it('asks for the second guest while keeping other fields on that request', async () => {
    const revision = await agencyRevision();
    const draft = await buildBookingDrafts({
      analysis: analysis({
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
      }),
      revision,
      defaults: COMPLETE_DEFAULTS,
      messageId: 'message-1',
      validate: validateCreate,
    });
    expect(draft.rooms[0]!.request).toMatchObject({ firstName: 'John', lastName: 'Smith' });
    expect(draft.rooms[1]!.request).not.toHaveProperty('firstName');
    expect(draft.rooms[1]!.request).not.toHaveProperty('lastName');
    expect(draft.rooms[1]!.request).toMatchObject({
      roomType: 'STQN',
      ratePlan: 'TAXYZ',
      agency: 'XYZ TRAVEL',
    });
    expect(draft.missing.some((item) => item.question.includes('room 2'))).toBe(true);
  });

  it('records three schema errors and questions when defaults are all null', async () => {
    const revision = await agencyRevision();
    const draft = await buildBookingDrafts({
      analysis: analysis(),
      revision,
      defaults: NULL_DEFAULTS,
      messageId: 'message-1',
      validate: validateCreate,
    });
    for (const room of draft.rooms) {
      expect(room.request).not.toHaveProperty('track');
      expect(room.request).not.toHaveProperty('sourceOfBusiness');
      expect(room.request).not.toHaveProperty('guaranteeType');
      expect(room.schemaErrors.some((error) => error.includes('track'))).toBe(true);
      expect(room.schemaErrors.some((error) => error.includes('sourceOfBusiness'))).toBe(true);
      expect(room.schemaErrors.some((error) => error.includes('guaranteeType'))).toBe(true);
    }
    expect(draft.missing).toEqual(
      expect.arrayContaining([
        { field: 'track', question: 'Track for this booking?' },
        { field: 'sourceOfBusiness', question: 'Source of business for this booking?' },
        { field: 'guaranteeType', question: 'Guarantee type for this booking?' },
      ]),
    );
    expect(draft.missing.filter((item) => item.field === 'track')).toHaveLength(1);
  });

  it('names $.roomType when the quoted room code is not in the create schema', async () => {
    const revision = await agencyRevision({ roomCode: 'XYZ' });
    const draft = await buildBookingDrafts({
      analysis: analysis(),
      revision,
      defaults: COMPLETE_DEFAULTS,
      messageId: 'message-1',
      validate: validateCreate,
    });
    expect(draft.rooms[0]!.schemaErrors.some((error) => error.includes('$.roomType'))).toBe(true);
  });

  it('flags a government ask whose quote context has no organization', async () => {
    const revision = await agencyRevision({ context: {} });
    const draft = await buildBookingDrafts({
      analysis: analysis({
        party: { kind: 'government', name: 'Provincial Treasury', reference: null },
      }),
      revision,
      defaults: COMPLETE_DEFAULTS,
      messageId: 'message-1',
      validate: validateCreate,
    });
    expect(draft.flags).toContain('party_rate_not_applied');
  });

  it('does not mutate a frozen revision', async () => {
    const revision = await agencyRevision();
    const before = structuredClone(revision);
    Object.freeze(revision);
    Object.freeze(revision.groups);
    Object.freeze(revision.groups[0]);
    const draft = await buildBookingDrafts({
      analysis: analysis(),
      revision,
      defaults: COMPLETE_DEFAULTS,
      messageId: 'message-1',
      validate: validateCreate,
    });
    expect(draft.rooms).toHaveLength(2);
    expect(revision).toEqual(before);
  });
});

describe('prepareBookingDraft route', () => {
  it('rejects an extra input key', () => {
    expect(() => prepareBookingDraftInput.parse({ ...draftInput, extra: true })).toThrow();
  });

  it('returns unavailable for an unknown workflowRunId', async () => {
    __setDbForTests({ db: emptySelectDb(), conn: null as never });
    const result = await draftCaller().workstation.prepareBookingDraft(draftInput);
    expect(result).toMatchObject({ status: 'unavailable' });
    expect(result).toHaveProperty('reason');
  });

  it('returns unavailable for a run from another transport', async () => {
    __setDbForTests({ db: emptySelectDb(), conn: null as never });
    const result = await draftCaller('transport-nava').workstation.prepareBookingDraft(draftInput);
    expect(result).toMatchObject({ status: 'unavailable' });
    expect(result).toHaveProperty('reason');
  });
});
