import type {
  BookingDraftReady,
  LunaAnalysisWire,
  QuoteOffer,
  QuoteSession,
  StaffQuoteAllocation,
  StayGroupRequirement,
} from '../lib/quote-workflow/types';
import {
  buildExpiredPriorRequoteBindArgs,
  overlayLunaGroupsFromStaff,
} from '../lib/quote-workflow/booking-draft-bind';
import {
  canCreatePdf,
  initialQuoteSession,
  ratedStayCount,
  reduceQuoteSession,
} from '../lib/quote-workflow/session';
import { combinedDocumentRequest } from '../lib/quote-workflow/quote-workbook-download';
import { bindQualifiedStaffProposalPdf } from '../lib/quote-workflow/staff-quote-bind';
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

function stayGroup(id: string, arrivalDate: string, departureDate: string): StayGroupRequirement {
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
  };
}

/** One stay's staff run, recorded the way the pane does when it finishes a search. */
function quoteStay(
  session: QuoteSession,
  option: { revisionRef: string; key: string; totalMinor: number },
  groups?: StayGroupRequirement[],
): QuoteSession {
  return reduceQuoteSession(session, {
    type: 'staff_quote_ready',
    offer: allocation(option.revisionRef, option.key, option.totalMinor),
    staffQuote: staffRun(session, option.revisionRef, option.key, option.totalMinor),
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
    selectedOfferIds: session.selectedOfferIds,
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

function lunaRow(arrival: string, departure: string, guestNames: string[]) {
  return {
    arrival,
    departure,
    rooms: 1,
    adultsPerRoom: 1,
    childAges: [],
    board: 'bb' as const,
    roomPreference: null,
    guestNames,
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
    const request = combinedDocumentRequest(twoQuotedStays());
    if (request.status !== 'ok') throw new Error(request.reason);
    expect(request.input.revisionRef).toBe('rev-a');
    expect(request.input.additionalStays?.map((stay) => stay.revisionRef)).toEqual(['rev-b']);
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

  it('gives each stay only its own guests, never another stay row by position', () => {
    // The December stay sits first in the quote, so its position would pick up the November row's guests.
    const luna = {
      groups: [lunaRow(NOV.arrival, NOV.departure, ['Mr John Smith'])],
    } as unknown as LunaAnalysisWire;
    const overlay = overlayLunaGroupsFromStaff(luna, [
      stayGroup('stay-b', DEC.arrival, DEC.departure),
      stayGroup('stay-a', NOV.arrival, NOV.departure),
    ]);
    expect(overlay.map((group) => [group.arrival, group.guestNames])).toEqual([
      [DEC.arrival, []],
      [NOV.arrival, ['Mr John Smith']],
    ]);
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
    const edited = reduceQuoteSession(session, { type: 'patch_group', groupId: 'stay-b', patch: { adults: 2 } });
    expect(Object.keys(edited.bookingDrafts)).toEqual([NOV.key]);
  });
});
