/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import {
  bindGetPriorStaffQuoteRequote,
  bindListThreadQuoteRevisions,
  bindPrepareBookingDraft,
  bindUsePriorQuoteForBooking,
  buildExpiredPriorRequoteBindArgs,
  EXPIRED_PRIOR_QUOTE_REQUOTE_LABEL,
  expiredPriorQuoteToastMessage,
  offerBoardFromRevision,
  overlayLunaGroupsFromStaff,
  staffQuoteGroupsForExpiredPriorRequote,
} from '../lib/quote-workflow/booking-draft-bind';
import { bindExecuteStaffQuote } from '../lib/quote-workflow/staff-quote-bind';
import { hasStaffStayEdits, initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import type {
  BookingDraftReady,
  LunaAnalysisWire,
  QuoteAnalysis,
  QuoteOffer,
  QuoteSession,
  StayGroupRequirement,
} from '../lib/quote-workflow/types';

afterEach(() => cleanup());

const STAFF_HASH = 'ab'.repeat(32);

const g1: StayGroupRequirement = {
  id: 'g1',
  arrivalDate: '2026-11-12',
  departureDate: '2026-11-14',
  quantity: 2,
  adults: 1,
  childrenAges: [],
  board: 'bb',
  specialRequests: [],
  fields: { arrivalDate: 'extracted', departureDate: 'extracted', adults: 'extracted' },
};

const luna: LunaAnalysisWire = {
  workflow: 'create_booking',
  flags: [],
  groups: [],
  party: { kind: 'agency', name: 'XYZ TRAVEL', reference: null },
  rateClaims: [],
  missing: [],
  evidence: [],
  tasks: [],
};

const analysis: QuoteAnalysis = {
  intent: 'quote',
  groups: [g1],
  secondaryAsks: [],
  alternatives: [],
  luna,
};

const offer: QuoteOffer = {
  id: 'rev-1',
  kind: 'allocation',
  roomCode: '',
  roomLabel: 'Selected allocation',
  board: 'bb',
  rateCode: '',
  currency: 'ZAR',
  nightly: [],
  stayTotalMinor: 850000,
  observedAt: '',
  sourceRef: 'rev-1',
  restrictions: [],
  combinable: true,
  quoteRequestKey: '2026-11-12:2026-11-14',
  coversGroupIds: ['g1'],
  quantity: 2,
};

const OPTIONS = {
  track: ['BAR', 'COR'],
  sourceOfBusiness: ['Travel Agent', 'E-Mail'],
  guaranteeType: ['Guaranteed By Agent', 'Confirmation Received'],
};

function draftReady(over: Partial<BookingDraftReady['draft']> = {}): BookingDraftReady {
  return {
    draft: {
      rooms: [
        {
          groupId: 'g1',
          roomIndex: 1,
          request: {
            arrival: '2026-11-12',
            departure: '2026-11-14',
            adults: 1,
            childAges: [],
            roomType: 'STQN',
            ratePlan: 'TAXYZ',
            agency: 'XYZ TRAVEL',
            firstName: 'John',
            lastName: 'Smith',
          },
          schemaErrors: [],
        },
        {
          groupId: 'g1',
          roomIndex: 2,
          request: {
            arrival: '2026-11-12',
            departure: '2026-11-14',
            adults: 1,
            childAges: [],
            roomType: 'STQN',
            ratePlan: 'TAXYZ',
            agency: 'XYZ TRAVEL',
            firstName: 'Jane',
            lastName: 'Doe',
          },
          schemaErrors: [],
        },
      ],
      rateCheck: [],
      missing: [],
      flags: [],
      ...over,
    },
    options: OPTIONS,
    messageId: 'mail-1',
    selectionEpoch: 1,
    inputRevision: 1,
    revisionRef: 'rev-1',
  };
}

function quotedSession(booking: BookingDraftReady | null = draftReady()): QuoteSession {
  let session = reduceQuoteSession(initialQuoteSession(), {
    type: 'selection',
    binding: {
      transportId: 't1',
      mailboxEmail: 'centurion@legacyhotels.co.za',
      storeId: 'store',
      folderEntryId: 'inbox',
      entryId: 'e1',
      selectionEpoch: 1,
      scopeEpoch: 1,
    },
  });
  session = reduceQuoteSession(session, { type: 'analysis_ready', analysis });
  session = reduceQuoteSession(session, {
    type: 'staff_source_ready',
    source: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: STAFF_HASH },
  });
  session = reduceQuoteSession(session, {
    type: 'staff_quote_ready',
    offer,
    staffQuote: {
      workflowRunId: 'run-1',
      revisionRef: 'rev-1',
      factRefs: [],
      messageId: 'mail-1',
      threadId: 'thread-1',
      sourceHash: STAFF_HASH,
      selectionEpoch: 1,
      inputRevision: session.inputRevision,
      inputDigest: 'digest',
      totalMinor: 850000,
      currency: 'ZAR',
      quoteRequestKey: '2026-11-12:2026-11-14',
      approvedHeader: {
        salesStrategy: 'BAR',
        company: '',
        agency: 'XYZ TRAVEL',
        attention: '',
        clientEmail: '',
        clientTelephone: '',
      },
    },
    selectionEpoch: 1,
    inputRevision: session.inputRevision,
  });
  if (!booking) return session;
  return reduceQuoteSession(session, {
    type: 'booking_draft_ready',
    payload: booking,
    sourceHash: STAFF_HASH,
  });
}

describe('booking cards', () => {
  it('renders one card per room with the agency name', () => {
    render(<QuoteWorkflowPanel session={quotedSession()} />);
    expect(screen.getAllByText('XYZ TRAVEL')).toHaveLength(2);
    expect(screen.getByText(/Room 1/i)).toBeDefined();
    expect(screen.getByText(/Room 2/i)).toBeDefined();
    expect(screen.getAllByText(/STQN · TAXYZ/)).toHaveLength(2);
    expect(screen.getByText('John Smith')).toBeDefined();
    expect(screen.getByText('Jane Doe')).toBeDefined();
    expect(screen.getAllByText('1 adult')).toHaveLength(2);
  });

  it('shows an amber mismatch banner with the claim quote', () => {
    render(
      <QuoteWorkflowPanel
        session={quotedSession(
          draftReady({
            rateCheck: [
              {
                status: 'mismatch',
                claimQuote: 'R1,700',
                assumedTaxBasis: false,
                differenceMinor: -15000,
              },
            ],
          }),
        )}
      />,
    );
    expect(screen.getByText(/R1,700/)).toBeDefined();
    expect(screen.getByText(/mismatch/i)).toBeDefined();
  });

  it('shows party_rate_not_applied on the booking draft', () => {
    render(
      <QuoteWorkflowPanel
        session={quotedSession(draftReady({ flags: ['party_rate_not_applied'] }))}
      />,
    );
    expect(screen.getByText('party_rate_not_applied')).toBeDefined();
  });

  it('disables Save with the coming-next copy', () => {
    render(<QuoteWorkflowPanel session={quotedSession()} />);
    const save = screen.getByRole('button', { name: /save/i });
    expect(save).toHaveProperty('disabled', true);
    expect(
      screen.getByText('Saving from the pane is coming next — copy into HMS'),
    ).toBeDefined();
  });

  it('keeps track/source/guarantee selects local-only', () => {
    const session = quotedSession();
    render(<QuoteWorkflowPanel session={session} />);
    const track = screen.getAllByLabelText('Track')[0]!;
    fireEvent.change(track, { target: { value: 'COR' } });
    expect((track as HTMLSelectElement).value).toBe('COR');
    expect(session.bookingDraft?.draft.rooms[0]?.request.track).toBeUndefined();
  });
});

describe('bindPrepareBookingDraft', () => {
  const source = { messageId: 'mail-1', threadId: 'thread-1', sourceHash: STAFF_HASH };
  const input = {
    workflowRunId: 'run-1',
    revisionRef: 'rev-1',
    messageId: 'mail-1',
    selectionEpoch: 1,
    inputRevision: 1,
    analysis: luna,
  };

  it('rejects a result whose epoch, revision or messageId does not match', async () => {
    const staleEpoch = await bindPrepareBookingDraft({
      mutate: async () => ({ status: 'ready' as const, ...draftReady(), selectionEpoch: 9 }),
      source,
      ...input,
    });
    expect(staleEpoch.status).toBe('unavailable');
    const staleMessage = await bindPrepareBookingDraft({
      mutate: async () => ({ status: 'ready' as const, ...draftReady(), messageId: 'other' }),
      source,
      ...input,
    });
    expect(staleMessage.status).toBe('unavailable');
    const staleRevision = await bindPrepareBookingDraft({
      mutate: async () => ({ status: 'ready' as const, ...draftReady(), revisionRef: 'other-rev' }),
      source,
      ...input,
    });
    expect(staleRevision.status).toBe('unavailable');
  });

  it('returns unavailable when the client has no mutate', async () => {
    const bound = await bindPrepareBookingDraft({ source, ...input });
    expect(bound.status).toBe('unavailable');
  });
});

describe('bindUsePriorQuoteForBooking', () => {
  const source = { messageId: 'mail-1', threadId: 'thread-1', sourceHash: STAFF_HASH };

  it('does not call prepare when listThreadQuoteRevisions is empty', async () => {
    const listed = await bindListThreadQuoteRevisions({
      query: async () => ({ revisions: [] }),
      threadId: 'thread-1',
    });
    expect(listed).toEqual([]);
  });

  it('rejects an expired prior quote without returning a draft', async () => {
    const bound = await bindUsePriorQuoteForBooking({
      mutate: async () => ({ status: 'unavailable', reason: 'expired' }),
      source,
      workflowRunId: 'run-1',
      revisionRef: 'rev-1',
      threadId: 'thread-1',
      messageId: 'mail-1',
      selectionEpoch: 1,
      inputRevision: 1,
      analysis: luna,
    });
    expect(bound).toEqual({ status: 'unavailable', reason: 'expired' });
  });

  it('keeps extracted guest names when overlaying staff-edited stays', () => {
    const named: LunaAnalysisWire = {
      ...luna,
      groups: [
        {
          arrival: '2026-11-12',
          departure: '2026-11-14',
          rooms: 2,
          adultsPerRoom: 1,
          childAges: [],
          board: 'room_only',
          roomPreference: null,
          guestNames: ['John Smith', 'Jane Doe'],
        },
      ],
    };
    expect(
      overlayLunaGroupsFromStaff(named, [
        {
          arrivalDate: '2026-11-12',
          departureDate: '2026-11-14',
          quantity: 2,
          adults: 1,
          childrenAges: [],
          board: 'room_only',
        },
      ])[0]?.guestNames,
    ).toEqual(['John Smith', 'Jane Doe']);
  });

  it('maps a room-only revision board onto the reused offer', () => {
    expect(offerBoardFromRevision('room_only')).toBe('room_only');
    expect(offerBoardFromRevision('dinner_bed_breakfast')).toBe('dinner_bb');
  });
});

describe('expired prior re-quote', () => {
  const stored = {
    groups: [
      {
        id: 'prior-g1',
        arrivalDate: '2026-11-12',
        departureDate: '2026-11-14',
        quantity: 2,
        adults: 1,
        childrenAges: [7],
        board: 'bb' as const,
        roomCodes: ['STQN'],
      },
    ],
    salesStrategy: 'BAR' as const,
    company: 'Acme Corp',
    agency: 'XYZ TRAVEL',
  };

  it('exposes the re-quote label and expired toast copy', () => {
    expect(EXPIRED_PRIOR_QUOTE_REQUOTE_LABEL).toBe('Re-quote same stay');
    expect(expiredPriorQuoteToastMessage()).toMatch(/expired/i);
  });

  it('sends prior groups and party header unchanged when staff has not edited stays', () => {
    const groups = staffQuoteGroupsForExpiredPriorRequote({
      stored,
      sessionGroups: [g1],
      staffEdited: false,
    });
    expect(groups).toMatchObject([
      {
        id: 'g1',
        arrivalDate: '2026-11-12',
        departureDate: '2026-11-14',
        quantity: 2,
        adults: 1,
        childrenAges: [7],
        board: 'bb',
        roomCodes: ['STQN'],
      },
    ]);
    const { header } = buildExpiredPriorRequoteBindArgs({
      stored,
      sessionGroups: [g1],
      sessionHeader: {
        salesStrategy: 'BAR',
        company: '',
        agency: '',
        attention: 'Front desk',
        clientEmail: '',
        clientTelephone: '',
      },
      staffEdited: false,
    });
    expect(header).toMatchObject({
      company: 'Acme Corp',
      agency: 'XYZ TRAVEL',
      attention: 'Front desk',
    });
  });

  it('uses patched session groups when staff edited after prefill', () => {
    const edited: StayGroupRequirement = {
      ...g1,
      quantity: 3,
      fields: { ...g1.fields, quantity: 'staff_corrected' },
    };
    const session = reduceQuoteSession({ ...initialQuoteSession(), groups: [g1] }, {
      type: 'patch_group',
      groupId: 'g1',
      patch: { quantity: 3 },
    });
    expect(hasStaffStayEdits(session)).toBe(true);
    const groups = staffQuoteGroupsForExpiredPriorRequote({
      stored,
      sessionGroups: [edited],
      staffEdited: true,
    });
    expect(groups).toMatchObject([{ quantity: 3, adults: 1 }]);
    expect(groups).not.toMatchObject([{ quantity: 2 }]);
  });

  it('calls executeStaffQuote with the resolved prior inputs', async () => {
    const mutate = vi.fn(async () => ({
      status: 'ready' as const,
      workflowRunId: 'run-new',
      revisionRef: 'rev-new',
      messageId: 'mail-1',
      threadId: 'thread-1',
      factRefs: [],
      selectionEpoch: 1,
      inputRevision: 1,
      inputDigest: 'digest',
      totalMinor: 100_00,
      currency: 'ZAR',
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-14',
      description: 'Stay',
    }));
    const { groups, header } = buildExpiredPriorRequoteBindArgs({
      stored,
      sessionGroups: [g1],
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
    await bindExecuteStaffQuote({
      mutate,
      source: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: STAFF_HASH },
      selectionEpoch: 1,
      inputRevision: 1,
      groups,
      header,
    });
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        groups: [expect.objectContaining({ id: 'g1', quantity: 2, roomCodes: ['STQN'] })],
        company: 'Acme Corp',
        agency: 'XYZ TRAVEL',
        salesStrategy: 'BAR',
      }),
    );
  });

  it('loads stored payload through getPriorStaffQuoteRequote', async () => {
    const bound = await bindGetPriorStaffQuoteRequote({
      query: async () => ({ status: 'ready', payload: stored }),
      threadId: 'thread-1',
      row: { workflowRunId: 'run-1', revisionRef: 'rev-1' },
    });
    expect(bound).toEqual({ status: 'ok', payload: stored });
  });
});
