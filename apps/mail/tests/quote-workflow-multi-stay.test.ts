import {
  canCreatePdf,
  groupsForQuoteStep,
  initialQuoteSession,
  pdfBlocker,
  ratedStayCount,
  reduceQuoteSession,
  stayIdOf,
} from '../lib/quote-workflow/session';
import { staffStayExtrasFor } from '../lib/quote-workflow/types';
import type {
  BookingDraftReady,
  LunaAnalysisWire,
  QuoteOffer,
  QuoteSession,
  StaffQuoteAllocation,
  StaffStayExtras,
  StayGroupRequirement,
} from '../lib/quote-workflow/types';
import {
  bindExecuteStaffQuote,
  bindQualifiedStaffProposalPdf,
  type ExecuteStaffQuoteInput,
} from '../lib/quote-workflow/staff-quote-bind';
import {
  buildExpiredPriorRequoteBindArgs,
  overlayLunaGroupsFromStaff,
} from '../lib/quote-workflow/booking-draft-bind';
import { combinedDocumentRequest } from '../lib/quote-workflow/quote-workbook-download';
import { requireMultiOptionDraft } from '../lib/quote-workflow/multi-option-draft';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

/** Two date options quoted in one session: the combined quote and its booking drafts. */

const BINDING = {
  transportId: 't1',
  mailboxEmail: 'centurion@legacyhotels.co.za',
  storeId: 'store',
  folderEntryId: 'inbox',
  entryId: 'e1',
  selectionEpoch: 1,
  scopeEpoch: 1,
};
const SOURCE_HASH = 'ab'.repeat(32);
const NOV = { key: '2027-11-12:2027-11-14', arrival: '2027-11-12', departure: '2027-11-14' };
const DEC = { key: '2027-12-01:2027-12-03', arrival: '2027-12-01', departure: '2027-12-03' };
const COMBINED_BYTES = Buffer.from('%PDF-1.4 combined').toString('base64');

function stayGroup(
  id: string,
  arrivalDate: string,
  departureDate: string,
  stayId?: string,
): StayGroupRequirement {
  return {
    id,
    ...(stayId ? { stayId } : {}),
    arrivalDate,
    departureDate,
    quantity: 1,
    roomPreference: 'standard king',
    adults: 1,
    childrenAges: [],
    board: 'bb',
    specialRequests: [],
    fields: { arrivalDate: 'extracted', departureDate: 'extracted', adults: 'extracted' },
  };
}

function allocation(revisionRef: string, quoteRequestKey: string, totalMinor: number): QuoteOffer {
  return {
    id: revisionRef,
    kind: 'allocation',
    roomCode: '',
    roomLabel: 'Standard King',
    board: 'bb',
    rateCode: '',
    currency: 'ZAR',
    nightly: [],
    stayTotalMinor: totalMinor,
    observedAt: '',
    sourceRef: revisionRef,
    restrictions: [],
    combinable: true,
    quoteRequestKey,
    coversGroupIds: [quoteRequestKey === NOV.key ? 'stay-a' : 'stay-b'],
    quantity: 1,
    adults: 1,
  };
}

function staffRun(
  session: QuoteSession,
  revisionRef: string,
  quoteRequestKey: string,
  totalMinor: number,
  onceExtras = false,
): StaffQuoteAllocation {
  return {
    workflowRunId: `run-${revisionRef}`,
    revisionRef,
    factRefs: [],
    messageId: 'mail-1',
    threadId: 'thread-1',
    sourceHash: SOURCE_HASH,
    selectionEpoch: 1,
    inputRevision: session.inputRevision,
    inputDigest: `digest-${revisionRef}`,
    totalMinor,
    currency: 'ZAR',
    quoteRequestKey,
    approvedHeader: {
      salesStrategy: 'BAR',
      company: '',
      agency: '',
      attention: '',
      clientEmail: '',
      clientTelephone: '',
    },
    onceExtras,
  };
}

/** One stay's staff run, recorded the way the pane does when it finishes a search. */
function quoteStay(
  session: QuoteSession,
  option: { revisionRef: string; key: string; totalMinor: number; onceExtras?: boolean },
  groups?: StayGroupRequirement[],
): QuoteSession {
  return reduceQuoteSession(session, {
    type: 'staff_quote_ready',
    offer: allocation(option.revisionRef, option.key, option.totalMinor),
    staffQuote: staffRun(session, option.revisionRef, option.key, option.totalMinor, option.onceExtras),
    selectionEpoch: 1,
    inputRevision: session.inputRevision,
    ...(groups ? { groups } : {}),
  });
}

function stayedSession(): QuoteSession {
  let session = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: BINDING });
  session = reduceQuoteSession(session, {
    type: 'analysis_ready',
    analysis: {
      intent: 'quote',
      groups: [
        stayGroup('stay-a', NOV.arrival, NOV.departure),
        stayGroup('stay-b', DEC.arrival, DEC.departure),
      ],
      secondaryAsks: [],
      alternatives: [],
    },
  });
  return reduceQuoteSession(session, {
    type: 'staff_source_ready',
    source: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: SOURCE_HASH },
  });
}

function twoQuotedStays(): QuoteSession {
  const first = quoteStay(stayedSession(), {
    revisionRef: 'rev-a',
    key: NOV.key,
    totalMinor: 272000,
  });
  return quoteStay(first, { revisionRef: 'rev-b', key: DEC.key, totalMinor: 136000 });
}

/** The combined PDF the server returns for both stays: its revision names the set of stays. */
function withCombinedPdf(session: QuoteSession): QuoteSession {
  return reduceQuoteSession(session, {
    type: 'pdf_ready',
    pdf: {
      fileName: 'Quote - Standard King.pdf',
      bytesBase64: COMBINED_BYTES,
      pdfHash: 'cd'.repeat(32),
      revisionId: 'quotes:both',
      totalMinor: 408000,
    },
    selectionEpoch: 1,
    inputRevision: session.inputRevision,
    // The pane names the stays' runs the combined PDF was built from.
    selectedOfferIds: Object.values(session.staffQuotes).map((quote) => quote.revisionRef),
  });
}

function bookingDraftFor(session: QuoteSession, revisionRef: string): BookingDraftReady {
  return {
    draft: { rooms: [], rateCheck: [], missing: [], flags: [] },
    options: { track: [], sourceOfBusiness: [], guaranteeType: [], roomType: [] },
    messageId: 'mail-1',
    selectionEpoch: 1,
    inputRevision: session.inputRevision,
    revisionRef,
  };
}

function lunaRow(arrival: string, departure: string, guestNames: string[], stayId?: string) {
  return {
    arrival,
    departure,
    rooms: 1,
    adultsPerRoom: 1,
    childAges: [],
    board: 'bb' as const,
    roomPreference: null,
    guestNames,
    ...(stayId ? { stayId } : {}),
  };
}

describe('Prepare quote for a multi-stay quote', () => {
  it('waits for every stay: "1 of 2 stays rated" until the second stay has a current run', () => {
    const first = quoteStay(stayedSession(), {
      revisionRef: 'rev-a',
      key: NOV.key,
      totalMinor: 272000,
    });
    expect(ratedStayCount(first)).toEqual({ rated: 1, total: 2 });
    expect(canCreatePdf(first)).toBe(false);
    expect(combinedDocumentRequest(first)).toEqual({
      status: 'unavailable',
      reason: '1 of 2 stays rated',
    });

    const both = twoQuotedStays();
    expect(ratedStayCount(both)).toEqual({ rated: 2, total: 2 });
    expect(canCreatePdf(both)).toBe(true);
  });

  it('asks for one document: the first stay is the request and every other stay goes in as additionalStays', () => {
    const both = twoQuotedStays();
    const firstStay = both.staffQuotes[NOV.key]!;
    const secondStay = both.staffQuotes[DEC.key]!;
    const session = {
      ...both,
      staffQuotes: {
        ...both.staffQuotes,
        [NOV.key]: {
          ...firstStay,
          approvedHeader: { ...firstStay.approvedHeader!, notes: 'First stay note.' },
        },
        [DEC.key]: {
          ...secondStay,
          approvedHeader: { ...secondStay.approvedHeader!, notes: 'Second stay note.' },
        },
      },
    };
    const request = combinedDocumentRequest(session);
    if (request.status !== 'ok') throw new Error(request.reason);
    expect(request.input.revisionRef).toBe('rev-a');
    expect(request.input.notes).toBe('First stay note.');
    expect(request.input.additionalStays).toEqual([
      expect.objectContaining({ revisionRef: 'rev-b', notes: 'Second stay note.' }),
    ]);
    expect(request.expectedTotalMinor).toBe(408000);
  });

  it('a re-quote of stay 2 keeps stay 1 result and drops the combined PDF made before it', () => {
    const before = withCombinedPdf(twoQuotedStays());
    expect(requireMultiOptionDraft(before)).not.toBeNull();

    const after = quoteStay(before, { revisionRef: 'rev-b2', key: DEC.key, totalMinor: 150000 });
    expect(after.staffQuotes[NOV.key]).toBe(before.staffQuotes[NOV.key]);
    expect(ratedStayCount(after)).toEqual({ rated: 2, total: 2 });
    expect(after.pdf).toBeNull();
    expect(requireMultiOptionDraft(after)).toBeNull();

    const request = combinedDocumentRequest(after);
    if (request.status !== 'ok') throw new Error(request.reason);
    expect(request.input.additionalStays?.[0]?.revisionRef).toBe('rev-b2');
    expect(request.expectedTotalMinor).toBe(422000);
  });
});

describe('the combined PDF and its binding', () => {
  it('accepts the combined document for the set of stays and rejects one that covers only the first stay', async () => {
    const request = combinedDocumentRequest(twoQuotedStays());
    if (request.status !== 'ok') throw new Error(request.reason);
    const pdf = {
      revisionId: 'quotes:both',
      pdfHash: createHash('sha256').update(Buffer.from(COMBINED_BYTES, 'base64')).digest('hex'),
      fileName: 'Quote - Standard King.pdf',
      pdfBase64: COMBINED_BYTES,
      totalMinor: 408000,
    };
    const combined = await bindQualifiedStaffProposalPdf({
      mutate: async () => pdf,
      input: request.input,
      expectedTotalMinor: request.expectedTotalMinor,
    });
    expect(combined.status).toBe('ok');

    const firstOnly = await bindQualifiedStaffProposalPdf({
      mutate: async () => ({ ...pdf, revisionId: 'rev-a', totalMinor: 272000 }),
      input: request.input,
      expectedTotalMinor: request.expectedTotalMinor,
    });
    expect(firstOnly.status).toBe('unavailable');
  });
});

describe('one booking draft and one set of guests per stay', () => {
  it('keeps one booking draft per stay and drops only the draft of a re-quoted stay', () => {
    let session = twoQuotedStays();
    session = reduceQuoteSession(session, {
      type: 'booking_draft_ready',
      payload: bookingDraftFor(session, 'rev-a'),
      sourceHash: SOURCE_HASH,
    });
    session = reduceQuoteSession(session, {
      type: 'booking_draft_ready',
      payload: bookingDraftFor(session, 'rev-b'),
      sourceHash: SOURCE_HASH,
    });
    expect(session.bookingDrafts[NOV.key]?.revisionRef).toBe('rev-a');
    expect(session.bookingDrafts[DEC.key]?.revisionRef).toBe('rev-b');

    const requoted = quoteStay(session, {
      revisionRef: 'rev-b2',
      key: DEC.key,
      totalMinor: 150000,
    });
    expect(Object.keys(requoted.bookingDrafts)).toEqual([NOV.key]);
  });

  it('a re-quote that carries one stay row replaces only that row', () => {
    const session = twoQuotedStays();
    const requoted = quoteStay(
      session,
      { revisionRef: 'rev-b2', key: DEC.key, totalMinor: 150000 },
      [{ ...stayGroup('stay-b', DEC.arrival, DEC.departure), quantity: 2 }],
    );
    expect(requoted.groups.map((group) => [group.id, group.quantity])).toEqual([
      ['stay-a', 1],
      ['stay-b', 2],
    ]);
  });

  it('keeps each same-date stay its own guests', () => {
    const luna = {
      groups: [
        lunaRow(NOV.arrival, NOV.departure, ['Ada Example']),
        lunaRow(NOV.arrival, NOV.departure, ['Bea Example']),
      ],
    } as unknown as LunaAnalysisWire;
    const overlay = overlayLunaGroupsFromStaff(luna, [
      stayGroup('stay-a', NOV.arrival, NOV.departure),
      stayGroup('stay-b', NOV.arrival, NOV.departure),
    ]);
    expect(overlay.map((group) => group.guestNames)).toEqual([['Ada Example'], ['Bea Example']]);
  });

  it('keeps guest names when staff rows have stayId and analysis rows do not', () => {
    const luna = {
      groups: [lunaRow(NOV.arrival, NOV.departure, ['Ada Example'])],
    } as unknown as LunaAnalysisWire;
    const overlay = overlayLunaGroupsFromStaff(luna, [
      stayGroup('stay-a', NOV.arrival, NOV.departure, 'stay-a'),
    ]);
    expect(overlay[0]?.guestNames).toEqual(['Ada Example']);
  });

  it('keeps the position fallback for a single stay whose dates the analysis wrote differently', () => {
    const luna = {
      groups: [lunaRow('2027-11-01', '2027-11-03', ['Mr John Smith'])],
    } as unknown as LunaAnalysisWire;
    const overlay = overlayLunaGroupsFromStaff(luna, [
      stayGroup('stay-a', NOV.arrival, NOV.departure),
    ]);
    expect(overlay[0]?.guestNames).toEqual(['Mr John Smith']);
  });

  it('keeps the surviving stay its own guest after the first stay is removed', () => {
    const luna = {
      groups: [
        lunaRow(NOV.arrival, NOV.departure, ['Ada Example'], 'stay-a'),
        lunaRow(DEC.arrival, DEC.departure, ['Bea Example'], 'stay-b'),
      ],
    } as unknown as LunaAnalysisWire;
    const overlay = overlayLunaGroupsFromStaff(luna, [
      stayGroup('stay-b', DEC.arrival, DEC.departure, 'stay-b'),
    ]);
    expect(overlay.map((group) => group.guestNames)).toEqual([['Bea Example']]);
  });

  it('gives each room of one stay its own guest', () => {
    const luna = {
      groups: [
        lunaRow(NOV.arrival, NOV.departure, ['Ada Example'], 'stay-a'),
        lunaRow(NOV.arrival, NOV.departure, ['Bea Example'], 'stay-a'),
      ],
    } as unknown as LunaAnalysisWire;
    const overlay = overlayLunaGroupsFromStaff(luna, [
      stayGroup('row-1', NOV.arrival, NOV.departure, 'stay-a'),
      stayGroup('row-2', NOV.arrival, NOV.departure, 'stay-a'),
    ]);
    expect(overlay.map((group) => group.guestNames)).toEqual([['Ada Example'], ['Bea Example']]);
  });

  it('re-binds an expired prior quote row to the session row of the same stay', () => {
    const sessionGroups = [
      stayGroup('stay-a', NOV.arrival, NOV.departure),
      stayGroup('stay-b', DEC.arrival, DEC.departure),
    ];
    const stored = {
      salesStrategy: 'BAR' as const,
      company: '',
      agency: '',
      groups: [
        {
          id: 'old-b',
          arrivalDate: DEC.arrival,
          departureDate: DEC.departure,
          quantity: 1,
          adults: 1,
          childrenAges: [],
          board: 'bb' as const,
        },
        {
          id: 'old-a',
          arrivalDate: NOV.arrival,
          departureDate: NOV.departure,
          quantity: 1,
          adults: 1,
          childrenAges: [],
          board: 'bb' as const,
        },
      ],
    };
    const { groups } = buildExpiredPriorRequoteBindArgs({
      stored,
      sessionGroups,
      sessionHeader: {
        salesStrategy: 'BAR',
        company: '',
        agency: '',
        attention: '',
        clientEmail: '',
        clientTelephone: '',
      },
      staffEdited: false,
    });
    expect(groups.map((group) => [group.id, group.arrivalDate])).toEqual([
      ['stay-b', DEC.arrival],
      ['stay-a', NOV.arrival],
    ]);
  });
});

describe('booking drafts when one stay is edited', () => {
  it("editing one stay keeps the other stay's booking draft", () => {
    const session = {
      ...twoQuotedStays(),
      bookingDrafts: { [NOV.key]: {} as never, [DEC.key]: {} as never },
    };
    const edited = reduceQuoteSession(session, {
      type: 'patch_group',
      groupId: 'stay-b',
      patch: { adults: 2 },
    });
    expect(Object.keys(edited.bookingDrafts)).toEqual([NOV.key]);
  });
});

describe('per-stay extras on a combined quote', () => {
  const ROOMS: Record<string, number> = { [NOV.key]: 272000, [DEC.key]: 136000 };

  function withStayExtras(session: QuoteSession, stayKey: string, extras: Partial<StaffStayExtras>) {
    return reduceQuoteSession(session, { type: 'patch_staff_stay_extras', stayKey, extras });
  }

  /** A server stand-in that prices each stay's rooms plus the shuttle and any flat "other" charge it is sent. */
  function pricedMutate(sent: ExecuteStaffQuoteInput[]) {
    return async (input: ExecuteStaffQuoteInput) => {
      sent.push(input);
      const group = input.groups[0]!;
      const key = `${group.arrivalDate}:${group.departureDate}`;
      const shuttle = input.shuttleRequested
        ? (input.shuttleMinor ?? 0) * (input.shuttleTrips ?? 1)
        : 0;
      const other = input.other?.unit === 'item' ? input.other.amountMinor : 0;
      return {
        status: 'ready' as const,
        workflowRunId: `run-${key}-${sent.length}`,
        revisionRef: `rev-${key}-${sent.length}`,
        messageId: 'mail-1',
        threadId: 'thread-1',
        factRefs: shuttle || other ? ['extras'] : [],
        selectionEpoch: input.selectionEpoch,
        inputRevision: input.inputRevision,
        inputDigest: `digest-${sent.length}`,
        totalMinor: ROOMS[key]! + shuttle + other,
        currency: 'ZAR',
        arrivalDate: group.arrivalDate,
        departureDate: group.departureDate,
        description: 'Standard King',
      };
    };
  }

  /** Runs one stay the way the pane does: that stay's rows and extras. */
  async function runStay(
    session: QuoteSession,
    key: string,
    sent: ExecuteStaffQuoteInput[],
  ): Promise<QuoteSession> {
    const step = session.steps.find((item) => item.shareKey === key)!;
    const groups = groupsForQuoteStep(session, step).map((group) => ({
      ...group,
      roomCodes: ['SKNG'],
    }));
    const run = await bindExecuteStaffQuote({
      mutate: pricedMutate(sent),
      source: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: SOURCE_HASH },
      selectionEpoch: 1,
      inputRevision: session.inputRevision,
      groups,
      header: session.staffHeader,
      stayKey: key,
    });
    if (run.status !== 'ok') throw new Error(run.reason);
    return reduceQuoteSession(session, {
      type: 'staff_quote_ready',
      offer: run.offer,
      staffQuote: run.staffQuote,
      selectionEpoch: 1,
      inputRevision: session.inputRevision,
      approvedHeader: session.staffHeader,
    });
  }

  it('charges a shuttle separately for every stay where it is enabled', async () => {
    const sent: ExecuteStaffQuoteInput[] = [];
    let session = stayedSession();
    for (const key of [NOV.key, DEC.key]) {
      session = withStayExtras(session, key, { shuttleEnabled: true, shuttleMinor: 50_000, shuttleTrips: 1 });
    }
    // Each date range carries its own extra, even when the later stay runs first.
    session = await runStay(session, DEC.key, sent);
    session = await runStay(session, NOV.key, sent);
    expect(
      sent.map((input) => [input.groups[0]!.arrivalDate, input.shuttleRequested ?? false]),
    ).toEqual([
      [DEC.arrival, true],
      [NOV.arrival, true],
    ]);
    expect(sent.map((input) => input.shuttleMinor)).toEqual([50_000, 50_000]);
    const request = combinedDocumentRequest(session);
    if (request.status !== 'ok') throw new Error(request.reason);
    expect(request.expectedTotalMinor).toBe(272_000 + 136_000 + 2 * 50_000);
    expect(request.input.factRefs).toEqual(['extras']);
    expect(request.input.additionalStays?.[0]?.factRefs).toEqual(['extras']);
  });

  it('charges a one-item "other" amount per selected stay and sends per-person amounts to each stay', async () => {
    const sent: ExecuteStaffQuoteInput[] = [];
    let session = stayedSession();
    for (const key of [NOV.key, DEC.key]) {
      session = withStayExtras(session, key, {
        otherEnabled: true,
        other: { label: 'Conference pack', amountMinor: 20_000, unit: 'item' },
      });
    }
    session = await runStay(session, NOV.key, sent);
    session = await runStay(session, DEC.key, sent);
    expect(sent.map((input) => input.other?.amountMinor ?? null)).toEqual([20_000, 20_000]);
    const request = combinedDocumentRequest(session);
    if (request.status !== 'ok') throw new Error(request.reason);
    expect(request.expectedTotalMinor).toBe(272_000 + 136_000 + 40_000);

    const perPerson: ExecuteStaffQuoteInput[] = [];
    let each = stayedSession();
    for (const key of [NOV.key, DEC.key]) {
      each = withStayExtras(each, key, {
        otherEnabled: true,
        other: { label: 'Gala dinner', amountMinor: 30_000, unit: 'per_person' },
      });
    }
    each = await runStay(each, NOV.key, perPerson);
    each = await runStay(each, DEC.key, perPerson);
    expect(perPerson.map((input) => input.other?.unit ?? null)).toEqual([
      'per_person',
      'per_person',
    ]);
  });

  it('keeps each stay current only while its own single-charge extras remain unchanged', () => {
    let session = stayedSession();
    session = withStayExtras(session, NOV.key, { shuttleEnabled: true, shuttleMinor: 50_000, shuttleTrips: 1 });
    session = withStayExtras(session, DEC.key, { shuttleEnabled: false });
    session = quoteStay(session, { revisionRef: 'rev-a', key: NOV.key, totalMinor: 322_000, onceExtras: true });
    session = quoteStay(session, { revisionRef: 'rev-b', key: DEC.key, totalMinor: 136_000 });
    expect(ratedStayCount(session)).toEqual({ rated: 2, total: 2 });
    const changed = withStayExtras(session, NOV.key, { shuttleMinor: 60_000 });
    expect(ratedStayCount(changed)).toEqual({ rated: 1, total: 2 });
    expect(changed.staffQuotes[DEC.key]).toBe(session.staffQuotes[DEC.key]);
  });

  it('one stay still sends the shuttle as before', async () => {
    let session = reduceQuoteSession(initialQuoteSession(), {
      type: 'selection',
      binding: BINDING,
    });
    session = reduceQuoteSession(session, {
      type: 'analysis_ready',
      analysis: {
        intent: 'quote',
        groups: [stayGroup('stay-a', NOV.arrival, NOV.departure)],
        secondaryAsks: [],
        alternatives: [],
      },
    });
    session = reduceQuoteSession(session, {
      type: 'staff_source_ready',
      source: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: SOURCE_HASH },
    });
    session = withStayExtras(session, NOV.key, { shuttleEnabled: true, shuttleMinor: 50_000, shuttleTrips: 1 });
    const sent: ExecuteStaffQuoteInput[] = [];
    session = await runStay(session, NOV.key, sent);
    expect(sent[0]).toMatchObject({ shuttleRequested: true, shuttleMinor: 50000, shuttleTrips: 1 });
    expect(session.staffQuotes[NOV.key]?.totalMinor).toBe(322000);
  });
});

describe('the combined PDF while staff move between options', () => {
  it('a combined PDF that lands after another option was selected is kept', () => {
    const both = twoQuotedStays();
    const building = reduceQuoteSession(both, { type: 'select_stay_key', stayKey: NOV.key });
    expect(building.selectedStayKey).toBe(NOV.key);
    const landed = withCombinedPdf(building);
    expect(landed.pdf?.revisionId).toBe('quotes:both');
    expect(requireMultiOptionDraft(landed)).not.toBeNull();
  });

  it('a combined PDF built from a stay run that was since replaced is dropped', () => {
    const both = twoQuotedStays();
    const pending = Object.values(both.staffQuotes).map((quote) => quote.revisionRef);
    const requoted = quoteStay(both, { revisionRef: 'rev-b2', key: DEC.key, totalMinor: 150000 });
    const landed = reduceQuoteSession(requoted, {
      type: 'pdf_ready',
      pdf: {
        fileName: 'Quote - Standard King.pdf',
        bytesBase64: COMBINED_BYTES,
        pdfHash: 'cd'.repeat(32),
        revisionId: 'quotes:both',
        totalMinor: 408000,
      },
      selectionEpoch: 1,
      inputRevision: requoted.inputRevision,
      selectedOfferIds: pending,
    });
    expect(landed.pdf).toBeNull();
  });
});

describe('re-quoting an expired stay after staff edits', () => {
  const header = {
    salesStrategy: 'BAR' as const,
    company: '',
    agency: '',
    attention: '',
    clientEmail: '',
    clientTelephone: '',
  };
  const storedFor = (arrivalDate: string, departureDate: string) => ({
    salesStrategy: 'BAR' as const,
    company: '',
    agency: '',
    groups: [
      {
        id: 'old',
        arrivalDate,
        departureDate,
        quantity: 1,
        adults: 1,
        childrenAges: [],
        board: 'bb' as const,
      },
    ],
  });

  it('sends only the rows of the stay that quote was for, never every stay in one run', () => {
    const sessionGroups = [
      { ...stayGroup('stay-a', NOV.arrival, NOV.departure), stayId: 's1' },
      { ...stayGroup('stay-a2', NOV.arrival, NOV.departure), stayId: 's1' },
      { ...stayGroup('stay-b', DEC.arrival, DEC.departure), stayId: 's2' },
    ];
    const { groups } = buildExpiredPriorRequoteBindArgs({
      stored: storedFor(DEC.arrival, DEC.departure),
      sessionGroups,
      sessionHeader: header,
      staffEdited: true,
    });
    expect(groups.map((group) => group.id)).toEqual(['stay-b']);
  });

  it('sends nothing when staff moved that stay to other dates', () => {
    const { groups } = buildExpiredPriorRequoteBindArgs({
      stored: storedFor('2027-10-01', '2027-10-03'),
      sessionGroups: [
        stayGroup('stay-a', NOV.arrival, NOV.departure),
        stayGroup('stay-b', DEC.arrival, DEC.departure),
      ],
      sessionHeader: header,
      staffEdited: true,
    });
    expect(groups).toEqual([]);
  });

  it('a single stay still re-quotes the session rows as staff left them', () => {
    const sessionGroups = [{ ...stayGroup('stay-a', NOV.arrival, '2027-11-15'), stayId: 's1' }];
    const { groups } = buildExpiredPriorRequoteBindArgs({
      stored: storedFor(NOV.arrival, NOV.departure),
      sessionGroups,
      sessionHeader: header,
      staffEdited: true,
    });
    expect(groups).toBe(sessionGroups);
  });
});

describe('per-stay extras follow their stay', () => {
  const LATER = { key: '2027-12-05:2027-12-07', arrival: '2027-12-05', departure: '2027-12-07' };

  it("a date edit keeps the stay's saved extras", () => {
    let session = reduceQuoteSession(stayedSession(), {
      type: 'patch_staff_stay_extras',
      stayKey: DEC.key,
      extras: { shuttleEnabled: true, shuttleMinor: 45000 },
    });
    session = reduceQuoteSession(session, {
      type: 'patch_group',
      groupId: 'stay-b',
      patch: { arrivalDate: LATER.arrival, departureDate: LATER.departure },
    });
    const extras = staffStayExtrasFor(session.staffHeader, LATER.key);
    expect(extras.shuttleEnabled).toBe(true);
    expect(extras.shuttleMinor).toBe(45000);
    expect(session.staffHeader.stayExtrasByKey?.[DEC.key]).toBeUndefined();
  });

  it("a removed stay's bad amount no longer blocks documents", () => {
    let session = reduceQuoteSession(stayedSession(), {
      type: 'patch_staff_stay_extras',
      stayKey: DEC.key,
      extras: { fieldErrors: { shuttleAmount: 'Not a number' } },
    });
    expect(pdfBlocker(session)?.kind).toBe('amounts');
    const stayB = session.groups.find((group) => group.id === 'stay-b')!;
    session = reduceQuoteSession(session, { type: 'remove_stay', stayId: stayIdOf(stayB) });
    expect(pdfBlocker(session)?.kind).not.toBe('amounts');
  });
});
