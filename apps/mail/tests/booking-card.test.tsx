/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unmaskedPii } from './helpers/pii-marks';
import { BookingCards, ROOM_TYPE_CHANGED_COPY } from '../components/quote-workflow/booking-card';
import { ContactBlock } from '../components/nava-pane/blocks/contact-block';
import { QuotePeopleStep } from '../components/quote-workflow/quote-people-step';
import { QuoteBookingHost } from '../components/quote-workflow/quote-booking-host';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import type { StoredContact } from '../lib/quote-workflow/backend-bind';
import { resetGuestNameCacheForTests } from '../lib/quote-workflow/guest-name-cache';
import { trackPaneAction } from '../lib/quote-workflow/pane-telemetry';
import {
  bindGetPriorStaffQuoteRequote,
  bindListThreadQuoteRevisions,
  bindPrepareBookingDraft,
  bindUsePriorQuoteForBooking,
  buildExpiredPriorRequoteBindArgs,
  EXPIRED_PRIOR_QUOTE_REQUOTE_LABEL,
  expiredPriorQuoteNotice,
  expiredPriorQuoteToastMessage,
  offerBoardFromRevision,
  overlayLunaGroupsFromStaff,
  staffQuoteGroupsForExpiredPriorRequote,
} from '../lib/quote-workflow/booking-draft-bind';
import { bindExecuteStaffQuote } from '../lib/quote-workflow/staff-quote-bind';
import {
  commitOutcome,
  paneRefusalMessage,
  paneSaveModeOf,
  paneStayFromTrpc,
  paneUnconfirmedMessage,
  PANE_COMMIT_UNREACHABLE_COPY,
  PANE_PREVIEW_FAILED_COPY,
  PANE_SAVE_LAB_GUARD_COPY,
  PANE_SAVE_UNCONFIRMED_REASON,
  PANE_SAVE_UNVERIFIED_COPY,
  paneStayInputForRoom,
  readPaneSaveFlag,
  type PaneStayClient,
  type PaneStayResult,
} from '../lib/quote-workflow/pane-stay-bind';
import { hasStaffStayEdits, initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import { reservationNoteForGroup } from '../lib/quote-workflow/reservation-note';
import {
  emptyStaffQuoteHeader,
  HRDAV_PROPERTY_CODE,
  HRCEN_PROPERTY_CODE,
  type BookingDraftReady,
  type LunaAnalysisWire,
  type QuoteAnalysis,
  type QuoteOffer,
  type QuotePaneConfig,
  type QuoteSession,
  type StaffQuoteParties,
  type StayGroupRequirement,
} from '../lib/quote-workflow/types';

// sonner injects its stylesheet into the document on import (via hms-link-actions since U17), and every role query
// then pays for computed styles across the whole card. No test here reads a toast.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('../lib/quote-workflow/pane-telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/quote-workflow/pane-telemetry')>()),
  trackPaneAction: vi.fn(),
}));

afterEach(() => cleanup());

const STAFF_HASH = 'ab'.repeat(32);

const CARD_CONTACT: StoredContact = {
  name: 'Booker Example', company: null, endClient: null,
  email: 'booker@example.invalid', phone: null,
};
const CARD_CONFIRMATION = { userEmail: 'staff@example.invalid', setting: { mode: 'client' as const } };

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
  roomType: ['DLXKNG', 'STQN', 'SKNG'],
};

const PICKED: StaffQuoteParties = {
  company: { kind: 'company', nativeId: '49', name: 'Woolworths Holdings' },
  agency: { kind: 'agency', nativeId: '571', name: 'Woolworths Travel' },
};

// The draft as the server builds it when the quote carries no agency or organization.
function bareDraft(): BookingDraftReady {
  const draft = draftReady();
  for (const room of draft.draft.rooms) delete room.request.agency;
  return draft;
}

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
            bookerEmail: 'booker@example.invalid',
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
            bookerEmail: 'booker@example.invalid',
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

function quotedSession(
  booking: BookingDraftReady | null = draftReady(),
  parties?: StaffQuoteParties,
): QuoteSession {
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
  // Picks are header state and go out with the quote, so they are set before the quote runs.
  if (parties) {
    session = reduceQuoteSession(session, { type: 'patch_staff_header', header: { parties } });
  }
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
  // A pick above bumps the input revision, so the draft is for the revision the quote ran at.
  return reduceQuoteSession(session, {
    type: 'booking_draft_ready',
    payload: { ...booking, inputRevision: session.inputRevision },
    sourceHash: STAFF_HASH,
  });
}

const GENERATED_NOTE_STAY_KEY = '2026-11-12:2026-11-14';

function sessionWithGeneratedNote(booking: BookingDraftReady): QuoteSession {
  const session = quotedSession(booking);
  const quote = session.staffQuotes[GENERATED_NOTE_STAY_KEY];
  if (!quote) throw new Error('expected staff quote');
  return {
    ...session,
    groups: [{ ...session.groups[0]!, roomCodes: ['STWN'], rateCode: 'NCOR1B', board: 'bb' }],
    staffQuotes: {
      ...session.staffQuotes,
      [GENERATED_NOTE_STAY_KEY]: {
        ...quote,
        availabilityBoard: [
          {
            groupId: 'g1',
            roomCode: 'STWN',
            roomLabel: 'Standard Twin',
            rateCode: 'NCOR1B',
            rateLabel: 'Corporate negotiated',
            board: 'bb',
            boardLabel: 'Bed & breakfast',
            nightlyPriceMinor: 220000,
            roomsLeft: 2,
            rateScope: 'public',
          },
        ],
        rowRates: [
          {
            groupId: 'g1',
            source: 'hms',
            hmsNightlyMinor: [215000, 225000],
            nightlyMinor: [215000, 225000],
            rateCode: 'NCOR1B',
          },
        ],
      },
    },
  };
}

function sessionWithBoardRoomLabel(session: QuoteSession, roomLabel: string): QuoteSession {
  const quote = session.staffQuotes[GENERATED_NOTE_STAY_KEY];
  const row = quote?.availabilityBoard?.[0];
  if (!quote || !row) throw new Error('expected availability row');
  return {
    ...session,
    staffQuotes: {
      ...session.staffQuotes,
      [GENERATED_NOTE_STAY_KEY]: { ...quote, availabilityBoard: [{ ...row, roomLabel }] },
    },
  };
}

describe('booking cards', () => {
  it('shows editable room and rate controls for each booking', () => {
    const { client } = paneClient();
    render(<BookingCards draft={draftReady()} paneSave={client} />);

    expect(screen.getAllByLabelText('Room type')).toHaveLength(2);
    expect(screen.getAllByLabelText('Rate plan')).toHaveLength(2);
    for (const label of ['Arrival', 'Departure', 'Adults', 'Children', 'Meal plan', 'Rate code']) {
      expect(screen.queryByRole('button', { name: new RegExp(`Copy ${label} for`) })).toBeNull();
    }
    expect(screen.queryByLabelText('Booker name')).toBeNull();
    expect(screen.queryByLabelText('Booker contact (email)')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Preview in HMS' })).toHaveLength(2);
    expect(screen.getAllByLabelText('Track')).toHaveLength(2);
    expect(screen.getAllByLabelText('Source of business')).toHaveLength(2);
    expect(screen.getAllByLabelText('Guarantee')).toHaveLength(2);
    expect(screen.getAllByLabelText('Market Segment')).toHaveLength(2);
    expect(screen.getAllByRole('checkbox', { name: 'Guest opt-in' })).toHaveLength(2);
  });

  it('keeps guest opt-in unchecked until staff selects it and sends generic Market Segment', async () => {
    const { client, preview } = paneClient();
    const draft = draftReady({ rooms: [draftReady().draft.rooms[0]!] });
    const session = quotedSession(draft);
    const workItemId = '11111111-1111-1111-1111-111111111111';
    const host = (currentSession: QuoteSession) => (
      <QuoteBookingHost session={currentSession} paneSave={client} workItemId={workItemId} />
    );
    const { rerender } = render(host(session));

    const marketSegment = screen.getByLabelText('Market Segment') as HTMLInputElement;
    const guestOptIn = screen.getByRole('checkbox', { name: 'Guest opt-in' }) as HTMLInputElement;
    expect(marketSegment.value).toBe('');
    expect(guestOptIn.checked).toBe(false);

    fireEvent.change(marketSegment, { target: { value: 'Leisure' } });
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    await waitFor(() =>
      expect(preview).toHaveBeenCalledWith(
        expect.objectContaining({ marketSegment: 'Leisure', guestoptin4: false }),
      ),
    );

    fireEvent.click(guestOptIn);
    expect(guestOptIn.checked).toBe(true);
    fireEvent.click(previewButton(0));
    await waitFor(() =>
      expect(preview).toHaveBeenLastCalledWith(
        expect.objectContaining({ marketSegment: 'Leisure', guestoptin4: true }),
      ),
    );

    const nextSession = quotedSession(draft);
    nextSession.binding = { ...nextSession.binding!, entryId: 'e2', selectionEpoch: 2 };
    rerender(host(nextSession));
    expect((screen.getByLabelText('Market Segment') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('checkbox', { name: 'Guest opt-in' }) as HTMLInputElement).checked).toBe(false);
  });

  it('builds the HMS preview from the current Stay group instead of stale draft values', () => {
    const { client, preview } = paneClient();
    const draft = draftReady({ rooms: [draftReady().draft.rooms[0]!] });
    const currentGroup: StayGroupRequirement = {
      ...g1,
      arrivalDate: '2026-12-03',
      departureDate: '2026-12-05',
      adults: 2,
      roomPreference: 'DLXKNG',
      roomTypeCode: 'DLXKNG',
      roomCodes: ['DLXKNG'],
      rateCode: 'NEWBAR',
      quotedRateCode: 'OLDERQUOTE',
      fields: { ...g1.fields, roomCodes: 'staff_corrected' },
    };
    render(<BookingCards draft={draft} groups={[currentGroup]} paneSave={client} />);
    pickRoomChoices(0);

    fireEvent.click(previewButton(0));

    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({
        arrival: '2026-12-03',
        departure: '2026-12-05',
        adults: 2,
        roomType: 'DLXKNG',
        ratePlan: 'NEWBAR',
      }),
    );
  });

  it('uses the quoted rate plan before the request default', () => {
    const { client, preview } = paneClient();
    const draft = draftReady({ rooms: [draftReady().draft.rooms[0]!] });
    draft.draft.rooms[0]!.request.ratePlan = 'TAXYZ';
    const group: StayGroupRequirement = { ...g1, quotedRateCode: 'QUOTED' };
    render(<BookingCards draft={draft} groups={[group]} paneSave={client} />);
    pickRoomChoices(0);

    fireEvent.click(previewButton(0));

    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ ratePlan: 'QUOTED' }));
  });

  it('keeps the prepared native room code when the Stay has only an unmatched room name', () => {
    const { client, preview } = paneClient();
    const draft = draftReady({ rooms: [draftReady().draft.rooms[0]!] });
    draft.draft.rooms[0]!.request.roomType = 'JNRSUI';
    const group: StayGroupRequirement = {
      ...g1,
      roomPreference: 'Junior Suite',
      roomCodes: [],
    };
    render(<BookingCards draft={draft} groups={[group]} paneSave={client} />);
    pickRoomChoices(0);

    fireEvent.click(previewButton(0));

    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ roomType: 'JNRSUI' }));
  });

  it('keeps each draft allocation instead of indexing unpicked Stay room codes', () => {
    const { client, preview } = paneClient();
    const draft = draftReady();
    draft.draft.rooms[1]!.request.roomType = 'JNRSUI';
    const group: StayGroupRequirement = {
      ...g1,
      roomCodes: ['DLXKNG', 'ACCES'],
      fields: { ...g1.fields, roomCodes: 'extracted' },
    };
    render(<BookingCards draft={draft} groups={[group]} paneSave={client} />);
    pickRoomChoices(0);
    pickRoomChoices(1);

    fireEvent.click(previewButton(0));
    fireEvent.click(previewButton(1));

    expect(preview).toHaveBeenNthCalledWith(1, expect.objectContaining({ roomType: 'STQN' }));
    expect(preview).toHaveBeenNthCalledWith(2, expect.objectContaining({ roomType: 'JNRSUI' }));
  });

  it('uses one room code explicitly picked on Stay as replacement for draft allocations', () => {
    const { client, preview } = paneClient();
    const draft = draftReady();
    const group: StayGroupRequirement = {
      ...g1,
      roomPreference: 'DLXKNG',
      roomTypeCode: 'DLXKNG',
      fields: { ...g1.fields, roomPreference: 'staff_corrected' },
    };
    render(<BookingCards draft={draft} groups={[group]} paneSave={client} />);
    pickRoomChoices(0);
    pickRoomChoices(1);

    fireEvent.click(previewButton(0));
    fireEvent.click(previewButton(1));

    expect(preview).toHaveBeenNthCalledWith(1, expect.objectContaining({ roomType: 'DLXKNG' }));
    expect(preview).toHaveBeenNthCalledWith(2, expect.objectContaining({ roomType: 'DLXKNG' }));
  });

  it('renders create-only fields once per draft room', () => {
    render(<QuoteWorkflowPanel session={quotedSession()} />);
    const agencies = screen.getAllByLabelText('Booking agency') as unknown as HTMLSelectElement[];
    expect(agencies).toHaveLength(2);
    expect(agencies.every((field) => field.value === '')).toBe(true);
    expect(screen.getAllByLabelText('Last name').map((field) => (field as HTMLInputElement).value)).toEqual([
      'Smith',
      'Doe',
    ]);
    expect(screen.getAllByLabelText('First name').map((field) => (field as HTMLInputElement).value)).toEqual([
      'John',
      'Jane',
    ]);
  });

  it('does not render raw schema error strings on the card', () => {
    const draft = draftReady();
    draft.draft.rooms[0]!.schemaErrors = ['$.roomType required', '$.firstName required'];
    render(<BookingCards draft={draft} />);
    expect(screen.queryByText('$.roomType required')).toBeNull();
    expect(screen.queryByText('$.firstName required')).toBeNull();
    expect(screen.queryByText(/\$\.\w+ required/)).toBeNull();
  });

  it('does not show Nava does not write to HMS above the Book card', () => {
    const session = quotedSession();
    session.analysis = {
      ...session.analysis!,
      hmsTodoCard: {
        kind: 'new_booking',
        title: 'Key into HMS',
        writesEnabled: false,
        missing: [],
        steps: [{ label: 'Arrival', value: '2026-11-12', source: 'mail' }],
      },
    };
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.queryByRole('heading', { name: 'Book in HMS' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Key into HMS' })).toBeNull();
    expect(screen.queryByText('Nava does not write to HMS')).toBeNull();
  });

  it('keeps the free-text rate-code fallback in the inline rate row', () => {
    const draft = draftReady();
    for (const room of draft.draft.rooms) delete room.request.ratePlan;
    const onPatchGroup = vi.fn();
    render(<QuoteWorkflowPanel session={quotedSession(draft)} onPatchGroup={onPatchGroup} />);
    const fields = screen.getAllByLabelText('Rate code');
    expect(fields).toHaveLength(1);
    fireEvent.change(fields[0]!, { target: { value: 'barro' } });
    fireEvent.blur(fields[0]!);
    expect((fields[0] as HTMLInputElement).value).toBe('BARRO');
    expect(onPatchGroup).toHaveBeenCalledWith('g1', { rateCode: 'BARRO' });
  });

  it('does not patch an unchanged rate code on blur', () => {
    const session = quotedSession();
    session.groups[0] = { ...session.groups[0]!, rateCode: 'BARRO' };
    const onPatchGroup = vi.fn();
    render(<QuoteWorkflowPanel session={session} onPatchGroup={onPatchGroup} />);

    fireEvent.blur(screen.getByLabelText('Rate code'));

    expect(onPatchGroup).not.toHaveBeenCalled();
  });

  it('merges hotel-config and booking-draft room codes into one Stay selector', () => {
    const draft = draftReady();
    draft.options.roomType = [...draft.options.roomType, 'HOTEL-ONLY'];
    const session = quotedSession(draft);
    const paneConfig: QuotePaneConfig = {
      transportId: 't1',
      propertyCode: HRCEN_PROPERTY_CODE,
      roomTypes: [{ code: 'CONFIG-ONLY', label: 'Hotel configured room' }],
      ratePlans: [],
      boards: ['room_only', 'bb', 'dinner_bb'],
      salesStrategies: [],
      overrideRateCodes: [],
      eventRateCodes: [],
    };
    render(<QuoteWorkflowPanel session={session} paneConfig={paneConfig} />);
    const stay = screen.getByRole('article', { name: 'Stay 1 details' });
    const roomType = within(stay).getByLabelText('Room type') as unknown as HTMLSelectElement;
    const values = Array.from(roomType.options, (option) => option.value);
    expect(values.filter((value) => value === 'CONFIG-ONLY')).toHaveLength(1);
    expect(values.filter((value) => value === 'HOTEL-ONLY')).toHaveLength(1);
    expect(values).toContain('STQN');
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
    expect(screen.getByText(/differs from the email/i)).toBeDefined();
  });

  it('shows party_rate_not_applied on the booking draft', () => {
    render(
      <QuoteWorkflowPanel
        session={quotedSession(draftReady({ flags: ['party_rate_not_applied'] }))}
      />,
    );
    expect(screen.getByText(/Company rate not applied/)).toBeDefined();
  });

  it('shows copy guidance and a disabled writes-off create while pane save is off', () => {
    render(<QuoteWorkflowPanel session={quotedSession()} />);
    expect(
      screen.getByText(
        'Saving to HMS from this pane is off for now. Stay details are above; enter the booking-only fields in HMS Guest Stay.',
      ),
    ).toBeDefined();
    const writesOff = screen.getAllByRole('button', { name: 'Booking writes are off — create in HMS' });
    expect(writesOff).toHaveLength(2);
    expect(writesOff.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preview in HMS' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Book in HMS' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create provisional booking' })).toBeNull();
    expect(screen.queryByText('Coming soon')).toBeNull();
    expect(screen.queryByRole('button', { name: /save draft/i })).toBeNull();
  });

  it('prefills email source only when the booking request has no source', () => {
    const options = { ...OPTIONS, sourceOfBusiness: ['Walk In', 'Email', 'Phone'] };
    const emptySourceDraft = { ...draftReady(), options };
    const emptySource = render(<BookingCards draft={emptySourceDraft} />);
    expect(fieldValues('Source of business')[0]).toBe('Email');
    emptySource.unmount();

    const existingSourceDraft = { ...draftReady(), options };
    existingSourceDraft.draft.rooms[0]!.request.sourceOfBusiness = 'Phone';
    const existingSource = render(<BookingCards draft={existingSourceDraft} />);
    expect(fieldValues('Source of business')[0]).toBe('Phone');
    existingSource.unmount();

    const noEmailDraft = {
      ...draftReady(),
      options: { ...OPTIONS, sourceOfBusiness: ['Walk In', 'Phone'] },
    };
    render(<BookingCards draft={noEmailDraft} />);
    expect(fieldValues('Source of business')).toEqual(['Select source', 'Select source']);
    for (const copyButton of screen.getAllByRole('button', {
      name: 'Copy Source of business for Standard Queen ×2',
    })) {
      expect(copyButton).toHaveProperty('disabled', true);
    }
  });

  it('keeps track/source/guarantee selects local-only', () => {
    const session = quotedSession();
    render(<QuoteWorkflowPanel session={session} />);
    const track = screen.getAllByLabelText('Track')[0]!;
    fireEvent.change(track, { target: { value: 'COR' } });
    expect((track as unknown as HTMLSelectElement).value).toBe('COR');
    expect(Object.values(session.bookingDrafts)[0]?.draft.rooms[0]?.request.track).toBeUndefined();
  });

  it('drops the price check when the Stay room type changes, and restores it when reverted', () => {
    const draft = draftReady({
      rateCheck: [{ status: 'match', claimQuote: 'R1,750', assumedTaxBasis: false, differenceMinor: 0 }],
    });
    const quotedGroup: StayGroupRequirement = {
      ...g1,
      roomPreference: 'STQN',
      roomTypeCode: 'STQN',
      roomCodes: ['STQN'],
      fields: { ...g1.fields, roomCodes: 'staff_corrected' },
    };
    const { rerender } = render(<BookingCards draft={draft} groups={[quotedGroup]} />);
    expect(screen.getByText(/Price matches the email/)).toBeDefined();

    const changedGroup: StayGroupRequirement = {
      ...quotedGroup,
      roomPreference: 'DLXKNG',
      roomTypeCode: 'DLXKNG',
      roomCodes: ['DLXKNG'],
    };
    rerender(<BookingCards draft={draft} groups={[changedGroup]} />);
    expect(screen.queryByText(/Price matches the email/)).toBeNull();
    expect(screen.getByText(ROOM_TYPE_CHANGED_COPY)).toBeDefined();

    rerender(<BookingCards draft={draft} groups={[quotedGroup]} />);
    expect(screen.getByText(/Price matches the email/)).toBeDefined();
  });

  it('does not warn about a Stay room change when there is no quote', () => {
    const changedGroup: StayGroupRequirement = {
      ...g1,
      roomPreference: 'DLXKNG',
      roomTypeCode: 'DLXKNG',
      roomCodes: ['DLXKNG'],
    };
    render(<BookingCards draft={draftReady({ rateCheck: [] })} groups={[changedGroup]} />);
    expect(screen.queryByText(ROOM_TYPE_CHANGED_COPY)).toBeNull();
  });

  it('lists missing facts as muted labels, not amber questions', () => {
    render(
      <BookingCards
        draft={draftReady({
          missing: [{ field: 'guestName', question: 'Guest name for this booking?' }],
        })}
      />,
    );
    expect(screen.getByText('Guest name')).toBeDefined();
    expect(screen.queryByText('Guest name for this booking?')).toBeNull();
    expect(document.querySelectorAll('[class*="amber"]').length).toBe(0);
  });

  it('shows bound agency by name and keeps Organization separate', () => {
    render(<BookingCards draft={bareDraft()} parties={PICKED} />);
    expect(fieldValues('Organization')).toEqual(['Woolworths Holdings', 'Woolworths Holdings']);
    const agencies = screen.getAllByLabelText('Booking agency') as unknown as HTMLSelectElement[];
    expect(agencies).toHaveLength(2);
    for (const select of agencies) {
      expect(select.selectedOptions[0]?.textContent).toContain('Woolworths Travel');
      expect(select.value).not.toBe('');
    }
    const noAgency = within(agencies[0]! as unknown as HTMLElement).getByRole('option', { name: /no agency/i }) as unknown as HTMLOptionElement;
    fireEvent.change(agencies[0]!, { target: { value: noAgency.value } });
    expect(agencies[0]!.value).toBe(noAgency.value);
    expect(agencies[1]!.selectedOptions[0]?.textContent).toContain('Woolworths Travel');
  });

  it('keeps a staff-edited Organization when party picks change', () => {
    const { rerender } = render(<BookingCards draft={draftReady()} parties={PICKED} />);
    fireEvent.change(screen.getAllByLabelText('Organization')[0]!, { target: { value: 'Bidvest Bank' } });
    const other = { company: { kind: 'company' as const, nativeId: '77', name: 'Other Co' } };
    rerender(<BookingCards draft={draftReady()} parties={other} />);
    expect(fieldValues('Organization')[0]).toBe('Bidvest Bank');
  });

  it('requires staff to resolve an unbound draft agency before preview', () => {
    const { client, preview } = paneClient();
    const draft = previewableDraft();
    draft.draft.rooms[0]!.request.agency = 'Unbound Example';
    render(<BookingCards draft={draft} paneSave={client} />);
    expect(screen.getAllByText(/Unbound Example/i).length).toBeGreaterThan(0);
    expect(previewButton(0).disabled).toBe(true);
    expect(preview).not.toHaveBeenCalled();
    const select = screen.getByLabelText('Booking agency') as unknown as HTMLSelectElement;
    const noAgency = screen.getByRole('option', { name: /no agency/i }) as unknown as HTMLOptionElement;
    fireEvent.change(select, { target: { value: noAgency.value } });
    expect(previewButton(0).disabled).toBe(false);
    fireEvent.click(previewButton(0));
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0]?.[0]).not.toHaveProperty('bookingAgency');
  });

  it('does not offer a typed agency or company without an HMS id', () => {
    const typed = {
      company: { kind: 'company' as const, nativeId: '', name: 'Typed Co' },
      agency: { kind: 'agency' as const, nativeId: '', name: 'Typed Agency' },
    };
    render(<BookingCards draft={bareDraft()} parties={typed} />);
    expect(fieldValues('Organization')).toEqual(['', '']);
    for (const select of screen.getAllByLabelText('Booking agency') as unknown as HTMLSelectElement[]) {
      expect(Array.from(select.options).some((option) => option.textContent === 'Typed Agency')).toBe(false);
      expect(select.value).toBe('');
    }
  });

  it('passes picked company and bound agency from quote to booking card', () => {
    render(<QuoteWorkflowPanel session={quotedSession(bareDraft(), PICKED)} />);
    expect(fieldValues('Organization')).toEqual(['Woolworths Holdings', 'Woolworths Holdings']);
    for (const select of screen.getAllByLabelText('Booking agency') as unknown as HTMLSelectElement[]) {
      expect(select.selectedOptions[0]?.textContent).toContain('Woolworths Travel');
    }
  });
});

describe('booking card staying-guest prefill', () => {
  afterEach(() => resetGuestNameCacheForTests());

  it('prefills editable first and last names from the selected Guest, not Contact', () => {
    const contact: StoredContact = {
      name: 'Agent Booker',
      company: null,
      endClient: null,
      email: 'agent@example.invalid',
      phone: null,
    };
    const draft = draftReady({ rooms: [draftReady().draft.rooms[0]!] });
    draft.draft.rooms[0]!.request.firstName = 'Draft';
    draft.draft.rooms[0]!.request.lastName = 'Name';
    draft.draft.rooms[0]!.request.bookerName = 'Agent Booker';
    const { client, preview } = paneClient();
    const session = {
      staffSource: null,
      groups: [],
      analysis: {
        luna: {
          party: { kind: 'agency' },
          groups: [{ guestNames: [] }],
        },
      },
    } as unknown as QuoteSession;

    const view = (guestEditorKey: string) => (
      <>
        <QuotePeopleStep
          session={session}
          partyState="Optional"
          header={emptyStaffQuoteHeader()}
          contact={contact}
          contactEditorKey={guestEditorKey}
          scrollToStep={() => undefined}
        />
        <BookingCards draft={draft} paneSave={client} contact={contact} guestEditorKey={guestEditorKey} />
      </>
    );

    const firstPass = render(view('guest-prefill-unambiguous'));
    const guestOptIn = screen.getByRole('checkbox', { name: 'Guest opt-in' }) as HTMLInputElement;
    expect(guestOptIn.checked).toBe(false);
    fireEvent.click(guestOptIn);
    expect(guestOptIn.checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Guest'), { target: { value: 'Ada Example' } });
    const firstName = screen.getByLabelText('First name') as HTMLInputElement;
    const lastName = screen.getByLabelText('Last name') as HTMLInputElement;
    expect(firstName.value).toBe('Ada');
    expect(lastName.value).toBe('Example');
    expect(firstName).toHaveProperty('disabled', false);
    expect(lastName).toHaveProperty('disabled', false);
    expect(firstName.value).not.toBe('Agent');
    expect(lastName.value).not.toBe('Booker');
    expect(guestOptIn.checked).toBe(false);
    fireEvent.click(guestOptIn);
    expect(guestOptIn.checked).toBe(true);
    fireEvent.change(firstName, { target: { value: 'Bea' } });
    expect(firstName.value).toBe('Bea');
    expect(guestOptIn.checked).toBe(false);
    fireEvent.click(guestOptIn);
    expect(guestOptIn.checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Guest'), { target: { value: 'Cara Example' } });
    expect(firstName.value).toBe('Bea');
    expect(guestOptIn.checked).toBe(false);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'Bea', guestoptin4: false }));
    firstPass.unmount();

    resetGuestNameCacheForTests();
    render(view('guest-prefill-ambiguous'));
    const guest = screen.getByLabelText('Guest');
    fireEvent.change(guest, { target: { value: 'Ada' } });
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Draft');
    expect((screen.getByLabelText('Last name') as HTMLInputElement).value).toBe('Name');
    fireEvent.change(guest, { target: { value: 'Ada Marie' } });
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Ada');
    expect((screen.getByLabelText('Last name') as HTMLInputElement).value).toBe('Marie');
    fireEvent.change(guest, { target: { value: 'Ada Marie Example' } });
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Draft');
    expect((screen.getByLabelText('Last name') as HTMLInputElement).value).toBe('Name');
    expect((screen.getByLabelText('First name') as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText('Enter first and last name for the staying guest.')).toBeDefined();
  });
});

describe('booking card copy buttons', () => {
  function stubClipboard() {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    return writeText;
  }

  async function flushClipboard() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, 'clipboard');
    Reflect.deleteProperty(document, 'execCommand');
  });

  it('opens with plain-English guidance for manual HMS entry', () => {
    render(<BookingCards draft={draftReady()} />);
    expect(
      screen.getByText(
        'Saving to HMS from this pane is off for now. Stay details are above; enter the booking-only fields in HMS Guest Stay.',
      ),
    ).toBeDefined();
  });

  it('copies a create-only field and shows Copied for about 1.5 seconds', async () => {
    const writeText = stubClipboard();
    vi.useFakeTimers();
    render(<BookingCards draft={draftReady()} />);
    fireEvent.change(screen.getAllByLabelText('Track')[0]!, { target: { value: 'COR' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy Track for Standard Queen ×2' })[0]!);
    expect(writeText).toHaveBeenCalledWith('COR');
    await flushClipboard();
    expect(screen.getAllByRole('button', { name: 'Copied Track for Standard Queen ×2' })[0]).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getAllByRole('button', { name: 'Copy Track for Standard Queen ×2' })[0]).toBeDefined();
  });

  it('copies the track the staff picked, and stays disabled until one is picked', () => {
    const writeText = stubClipboard();
    render(<BookingCards draft={draftReady()} />);
    expect(screen.getAllByRole('button', { name: 'Copy Track for Standard Queen ×2' })[0]).toHaveProperty('disabled', true);
    fireEvent.change(screen.getAllByLabelText('Track')[0]!, { target: { value: 'COR' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy Track for Standard Queen ×2' })[0]!);
    expect(writeText).toHaveBeenCalledWith('COR');
  });

  it('shows the selected rate in the booking form without repeating the board or price', () => {
    render(
      <BookingCards
        draft={draftReady()}
        groups={[{ ...g1, board: 'room_only', rateCode: 'BARRO', quotedAmountMinor: 185000 }]}
      />,
    );
    expect(screen.queryByText('Room only')).toBeNull();
    expect(fieldValues('Rate plan')).toEqual(['BARRO', 'BARRO']);
    expect(screen.queryByText('R1850.00')).toBeNull();
    expect(screen.queryByText('Standard Queen ×2')).toBeNull();
  });

  function stubExecCommand(result: () => boolean) {
    const execCommand = vi.fn(() => result());
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    return execCommand;
  }

  it('falls back to a selected hidden textarea when the clipboard API is missing', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    let copiedFrom: string | undefined;
    const execCommand = stubExecCommand(() => {
      copiedFrom = (document.querySelector('textarea[readonly]') as HTMLTextAreaElement | null)?.value;
      return true;
    });
    render(<BookingCards draft={draftReady()} />);
    fireEvent.change(screen.getAllByLabelText('Track')[0]!, { target: { value: 'COR' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy Track for Standard Queen ×2' })[0]!);
    await flushClipboard();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copiedFrom).toBe('COR');
    expect(document.querySelector('textarea[readonly]')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Copied Track for Standard Queen ×2' })[0]).toBeDefined();
    expect(screen.queryByText('Copy failed – select the text')).toBeNull();
  });

  it('uses the same fallback when writeText rejects', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('NotAllowedError')));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const execCommand = stubExecCommand(() => true);
    render(<BookingCards draft={draftReady()} />);
    fireEvent.change(screen.getAllByLabelText('Track')[0]!, { target: { value: 'COR' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy Track for Standard Queen ×2' })[0]!);
    await flushClipboard();
    expect(writeText).toHaveBeenCalledWith('COR');
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(screen.getAllByRole('button', { name: 'Copied Track for Standard Queen ×2' })[0]).toBeDefined();
  });

  it('says Copy failed – select the text briefly when both copy paths fail', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.reject(new Error('NotAllowedError')));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    stubExecCommand(() => false);
    render(<BookingCards draft={draftReady()} />);
    fireEvent.change(screen.getAllByLabelText('Track')[0]!, { target: { value: 'COR' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy Track for Standard Queen ×2' })[0]!);
    await flushClipboard();
    expect(screen.getByText('Copy failed – select the text')).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Copy Track for Standard Queen ×2' })[0]).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText('Copy failed – select the text')).toBeNull();
  });
});

const PANE_DIGEST = 'c'.repeat(64);
const PANE_RUN = '11111111-2222-3333-4444-555555555555';
const PANE_SAVE_RUN = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const PREVIEW_OK: PaneStayResult = {
  status: 'ok',
  outcome: 'previewed',
  previewDigest: PANE_DIGEST,
  runId: PANE_RUN,
  screenshots: ['availability.png', 'filled.png'],
};
const COMMIT_OK: PaneStayResult = {
  status: 'ok',
  outcome: 'committed',
  confirmationNumber: '98765-1',
  runId: PANE_SAVE_RUN,
  screenshots: ['filled.png', 'saved.png'],
};
const JOHN_SMITH_PREVIEW = `Nava will book John Smith for 2026-11-12 – 2026-11-14, 1 room, rate TAXYZ. Nothing is saved until you press Create provisional booking.`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function paneClient(overrides: Partial<PaneStayClient> = {}) {
  const preview = vi.fn<PaneStayClient['preview']>().mockResolvedValue(PREVIEW_OK);
  const commit = vi.fn<PaneStayClient['commit']>().mockResolvedValue(COMMIT_OK);
  const screenshot = vi.fn<PaneStayClient['screenshot']>(async (_runId, name) => `data:image/png;base64,${name}`);
  // Default is the on mode. Tests that need lab or off override mode.
  const client: PaneStayClient = { preview, commit, screenshot, mode: () => 'on', ...overrides };
  return { client, preview, commit, screenshot };
}

function previewableDraft(track = 'COR'): BookingDraftReady {
  const draft = draftReady({ rooms: [draftReady().draft.rooms[0]!] });
  const request = draft.draft.rooms[0]!.request;
  request.track = track;
  request.sourceOfBusiness = 'E-Mail';
  request.guaranteeType = 'Confirmation Received';
  return draft;
}

function bookingSessionForPreview(draft: BookingDraftReady, selectionEpoch: number): QuoteSession {
  const session = quotedSession(draft);
  session.groups = session.groups.map((group) => ({ ...group, stayId: 'stay-preview-1' }));
  if (session.binding) session.binding = { ...session.binding, selectionEpoch };
  return session;
}

// The first room has no track, source or guarantee until the staff pick them.
function pickRoomChoices(index: number) {
  fireEvent.change(screen.getAllByLabelText('Track')[index]!, { target: { value: 'COR' } });
  fireEvent.change(screen.getAllByLabelText('Source of business')[index]!, { target: { value: 'E-Mail' } });
  fireEvent.change(screen.getAllByLabelText('Guarantee')[index]!, { target: { value: 'Confirmation Received' } });
}

function fieldValues(label: string): string[] {
  return screen.getAllByLabelText(label).map((field) => (field as HTMLInputElement).value);
}

function previewButton(index: number): HTMLButtonElement {
  return screen.getAllByRole('button', { name: 'Preview in HMS' })[index] as HTMLButtonElement;
}

function bookButton(index: number): HTMLButtonElement {
  return screen.getAllByRole('button', { name: 'Create provisional booking' })[index] as HTMLButtonElement;
}


describe('HRDAV booking fields and CMS', () => {
  function hrdavDraft(): BookingDraftReady {
    const draft = previewableDraft();
    draft.draft.rooms[0]!.request.roomType = 'DLXTWN';
    draft.options = {
      ...draft.options,
      roomType: ['DLXTWN', 'DLXKNG'],
      guaranteeType: ['Confirmation Received', 'CCIATA'],
      cmsMessageIds: [
        { code: '01', label: 'Guest booking – payment link' },
        { code: '03', label: 'Agency/company booking – payment link + proforma' },
        { code: '08', label: 'Agency booking – no rate' },
      ],
      cmsDefaults: { agency: '03', guest: '01' },
    } as BookingDraftReady['options'];
    return draft;
  }

  const agency = { agency: { kind: 'agency' as const, nativeId: '571', name: 'Woolworths Travel' } };

  it('renders editable fields in HMS order and only this hotel’s room options', () => {
    const draft = hrdavDraft();
    draft.draft.rooms[0]!.request.childAges = [5];
    const { container } = render(
      <BookingCards draft={draft} propertyCode={HRDAV_PROPERTY_CODE} parties={agency}
        contact={CARD_CONTACT} confirmation={CARD_CONFIRMATION} />,
    );
    const article = container.querySelector('article');
    expect(article).not.toBeNull();
    const room = within(article!);
    const fields = [
      room.getByLabelText('Booking agency'),
      room.getByLabelText('Guarantee'),
      room.getByLabelText('Room type'),
      room.getByLabelText('Rate plan'),
      room.getByLabelText('Adults'),
      room.getByLabelText(/child age 1/i),
      room.getByLabelText('First name'),
      room.getByLabelText('Source of business'),
      room.getByLabelText('Track'),
      room.getByLabelText('Market Segment'),
      room.getByRole('checkbox', { name: 'Guest opt-in' }),
      room.getByLabelText('Reservation note'),
    ];
    for (let i = 1; i < fields.length; i++) {
      expect(fields[i - 1]!.compareDocumentPosition(fields[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const types = room.getByLabelText('Room type') as unknown as HTMLSelectElement;
    const values = Array.from(types.options, (option) => option.value).filter(Boolean);
    expect(values).toEqual(['DLXTWN', 'DLXKNG']);
    expect(values).not.toContain('STQN');
    expect(values).not.toContain('SKNG');
    expect(room.getByRole('option', { name: 'CCIATA' })).toBeDefined();
  });

  it('defaults CMS by bound party, sends selected message and the exact bound HMS id', async () => {
    const { client, preview, commit } = paneClient();
    const draft = hrdavDraft();
    delete draft.draft.rooms[0]!.request.agency;
    render(<BookingCards draft={draft} propertyCode={HRDAV_PROPERTY_CODE} parties={agency}
      paneSave={client} contact={CARD_CONTACT} confirmation={CARD_CONFIRMATION} />);
    expect(screen.getByRole('checkbox', { name: 'Send confirmation from HMS' })).toHaveProperty('checked', true);
    const message = screen.getByLabelText('Message Id') as unknown as HTMLSelectElement;
    expect(message.value).toBe('03');
    fireEvent.change(message, { target: { value: '08' } });
    fireEvent.change(screen.getByLabelText('Guarantee'), { target: { value: 'CCIATA' } });
    fireEvent.click(previewButton(0));
    await waitFor(() => expect(bookButton(0).disabled).toBe(false));
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({
      bookingAgency: { name: 'Woolworths Travel', nativeId: '571' },
      guaranteeType: 'CCIATA',
      cmsMessageId: '08',
      confirmationSendMail: true,
      confirmationRecipient: { mode: 'client', address: 'booker@example.invalid' },
    }));
    fireEvent.click(bookButton(0));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(commit.mock.calls[0]?.[0]).toMatchObject({
      bookingAgency: { name: 'Woolworths Travel', nativeId: '571' }, cmsMessageId: '08',
    });
  });

  it('defaults to guest CMS type without a bound party and blocks a blank type', () => {
    const { client, preview } = paneClient();
    const draft = hrdavDraft();
    delete draft.draft.rooms[0]!.request.agency;
    render(<BookingCards draft={draft} paneSave={client} propertyCode={HRDAV_PROPERTY_CODE}
      contact={CARD_CONTACT} confirmation={CARD_CONFIRMATION} />);
    const message = screen.getByLabelText('Message Id') as unknown as HTMLSelectElement;
    expect(message.value).toBe('01');
    const blank = Array.from(message.options).find((option) => option.value === '');
    if (blank && !blank.disabled) {
      fireEvent.change(message, { target: { value: '' } });
      expect(screen.getByText(/confirmation type/i)).toBeDefined();
      expect(previewButton(0).disabled).toBe(true);
      expect(bookButton(0).disabled).toBe(true);
    } else {
      // A select with no selectable blank also enforces the non-blank contract.
      expect(message.value).not.toBe('');
    }
    expect(preview).not.toHaveBeenCalled();
  });

  it('uses the fallback CMS choices and guest or company default when profile CMS is absent', () => {
    const draft = hrdavDraft();
    draft.options = { ...OPTIONS, roomType: ['DLXTWN'] };
    delete draft.draft.rooms[0]!.request.agency;
    const { unmount } = render(<BookingCards draft={draft} propertyCode={HRDAV_PROPERTY_CODE}
      contact={CARD_CONTACT} confirmation={CARD_CONFIRMATION} />);
    const guest = screen.getByLabelText('Message Id') as unknown as HTMLSelectElement;
    expect(guest.value).toBe('01');
    expect(Array.from(guest.options, (option) => option.value)).toEqual(expect.arrayContaining(['01', '03', '08']));
    unmount();
    render(<BookingCards draft={draft} propertyCode={HRDAV_PROPERTY_CODE}
      parties={{ company: { kind: 'company', nativeId: '49', name: 'Woolworths Holdings' } }}
      contact={CARD_CONTACT} confirmation={CARD_CONFIRMATION} />);
    expect((screen.getByLabelText('Message Id') as unknown as HTMLSelectElement).value).toBe('03');
  });

  it('uses CMS options and defaults from the property profile when supplied', () => {
    const draft = hrdavDraft();
    draft.options = {
      ...draft.options,
      cmsMessageIds: [{ code: '21', label: 'Guest custom' }, { code: '23', label: 'Agency custom' }],
      cmsDefaults: { guest: '21', agency: '23' },
    } as BookingDraftReady['options'];
    render(<BookingCards draft={draft} parties={agency} propertyCode={HRDAV_PROPERTY_CODE}
      contact={CARD_CONTACT} confirmation={CARD_CONFIRMATION} />);
    const message = screen.getByLabelText('Message Id') as unknown as HTMLSelectElement;
    expect(message.value).toBe('23');
    expect(Array.from(message.options, (option) => option.value)).toEqual(expect.arrayContaining(['21', '23']));
  });

  it('blocks CMS preview and booking when no recipient is available', () => {
    const { client, preview, commit } = paneClient();
    const draft = hrdavDraft();
    delete draft.draft.rooms[0]!.request.bookerEmail;
    render(<BookingCards draft={draft} paneSave={client} propertyCode={HRDAV_PROPERTY_CODE} />);
    expect(screen.getByRole('checkbox', { name: 'Send confirmation from HMS' })).toHaveProperty('checked', true);
    expect(previewButton(0).disabled).toBe(true);
    expect(bookButton(0).disabled).toBe(true);
    fireEvent.click(previewButton(0));
    expect(preview).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not send a confirmation recipient when Send confirmation from HMS is off', () => {
    const { client, preview } = paneClient();
    const draft = hrdavDraft();
    render(<BookingCards draft={draft} paneSave={client} propertyCode={HRDAV_PROPERTY_CODE}
      contact={CARD_CONTACT} confirmation={CARD_CONFIRMATION} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send confirmation from HMS' }));
    fireEvent.click(previewButton(0));
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0]?.[0]).not.toHaveProperty('confirmationRecipient');
    expect(preview.mock.calls[0]?.[0]).toHaveProperty('cmsMessageId', '01');
    expect(preview.mock.calls[0]?.[0]).toHaveProperty('confirmationSendMail', false);
  });

  it('clearing a bound agency clears it from the preview instead of sending the draft name', () => {
    const { client, preview } = paneClient();
    const draft = hrdavDraft();
    render(<BookingCards draft={draft} paneSave={client} parties={agency} propertyCode={HRDAV_PROPERTY_CODE}
      contact={CARD_CONTACT} confirmation={CARD_CONFIRMATION} />);
    const noAgency = screen.getByRole('option', { name: /no agency/i }) as unknown as HTMLOptionElement;
    fireEvent.change(screen.getByLabelText('Booking agency'), { target: { value: noAgency.value } });
    fireEvent.click(previewButton(0));
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0]?.[0]).not.toHaveProperty('bookingAgency');
  });

  it('requires a new applicable rate and fresh preview after staff changes room type', async () => {
    const { client, preview } = paneClient();
    const draft = hrdavDraft();
    const initial: StayGroupRequirement = {
      ...g1, quantity: 1, roomTypeCode: 'DLXTWN', roomCodes: ['DLXTWN'], rateCode: 'TAXYZ',
      fields: { ...g1.fields, roomCodes: 'staff_corrected' },
    };
    const session = quotedSession(draft);
    const rateOption = {
      id: 'old-rate', groupId: 'g1', board: 'bb' as const, boardLabel: 'Bed & breakfast',
      rateCode: 'TAXYZ', rateLabel: 'Old rate', roomCode: 'DLXTWN', roomLabel: 'Deluxe Twin',
      contract: false, onlyContract: false, matchesRequest: true, perNightMinor: 100000,
      totalMinor: 200000, currency: 'ZAR', priced: 'full' as const, selected: true,
    };
    session.rateOptions = [rateOption];
    const view = (group: StayGroupRequirement, currentSession: QuoteSession) => (
      <BookingCards draft={draft} groups={[group]} paneSave={client} propertyCode={HRDAV_PROPERTY_CODE}
        session={currentSession} contact={CARD_CONTACT} confirmation={CARD_CONFIRMATION} />
    );
    const { rerender } = render(view(initial, session));
    fireEvent.click(previewButton(0));
    await waitFor(() => expect(bookButton(0).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Room type'), { target: { value: 'DLXKNG' } });
    expect(bookButton(0).disabled).toBe(true);
    expect(previewButton(0).disabled).toBe(true);
    expect((screen.getByLabelText('Rate plan') as unknown as HTMLSelectElement).value).not.toBe('TAXYZ');
    expect(preview).toHaveBeenCalledTimes(1);

    // A fresh applicable rate arrives for the new room, not the earlier room's quote.
    const refreshed = {
      ...session,
      rateOptions: [
        rateOption,
        { ...rateOption, id: 'new-rate', rateCode: 'NEWKNG', roomCode: 'DLXKNG', roomLabel: 'Deluxe King' },
      ],
    };
    rerender(view({ ...initial, roomTypeCode: 'DLXKNG', roomCodes: ['DLXKNG'], rateCode: 'NEWKNG' }, refreshed));
    const rate = screen.getByLabelText('Rate plan') as unknown as HTMLSelectElement;
    fireEvent.change(rate, { target: { value: 'NEWKNG' } });
    await waitFor(() => expect(previewButton(0).disabled).toBe(false));
    fireEvent.click(previewButton(0));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ roomType: 'DLXKNG', ratePlan: 'NEWKNG' })));
  });

  it('rejects child ages outside 0–17 and accepts the boundary values', async () => {
    const { client, preview } = paneClient();
    const draft = hrdavDraft();
    draft.draft.rooms[0]!.request.childAges = [5];
    render(<BookingCards draft={draft} paneSave={client} propertyCode={HRDAV_PROPERTY_CODE}
      contact={CARD_CONTACT} confirmation={CARD_CONFIRMATION} />);
    const age = screen.getByLabelText(/child age 1/i);
    for (const value of ['-1', '18']) {
      fireEvent.change(age, { target: { value } });
      expect(previewButton(0).disabled).toBe(true);
    }
    for (const value of ['0', '17']) {
      fireEvent.change(age, { target: { value } });
      expect(previewButton(0).disabled).toBe(false);
      fireEvent.click(previewButton(0));
      await waitFor(() => expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ childAges: [Number(value)] })));
      await waitFor(() => expect(bookButton(0).disabled).toBe(false));
    }
  });

  it('requires Market segment only while it is blank', async () => {
    const { client, preview } = paneClient();
    const draft = hrdavDraft();
    draft.options = { ...draft.options, requiredCreateFields: ['marketsegment'] };
    render(<BookingCards draft={draft} paneSave={client} propertyCode={HRDAV_PROPERTY_CODE}
      contact={CARD_CONTACT} confirmation={CARD_CONFIRMATION} />);
    expect(screen.getByText(/set market segment before you preview/i)).toBeDefined();
    expect(previewButton(0).disabled).toBe(true);
    expect(bookButton(0).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Market Segment'), { target: { value: 'Leisure' } });
    expect(screen.queryByText(/set market segment before you preview/i)).toBeNull();
    expect(screen.queryByText(/required hotel field/i)).toBeNull();
    expect(previewButton(0).disabled).toBe(false);
    fireEvent.click(previewButton(0));
    await waitFor(() => expect(preview).toHaveBeenCalledWith(expect.objectContaining({ marketSegment: 'Leisure' })));
  });

  it('requires Terms only when the hotel marks guestoptin4 required', async () => {
    const { client, preview } = paneClient();
    const draft = hrdavDraft();
    draft.options = { ...draft.options, requiredCreateFields: ['guestoptin4'] };
    render(<BookingCards draft={draft} paneSave={client} propertyCode={HRDAV_PROPERTY_CODE}
      contact={CARD_CONTACT} confirmation={CARD_CONFIRMATION} />);
    expect(previewButton(0).disabled).toBe(true);
    expect(screen.getAllByText(/terms/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Guest opt-in' }));
    expect(previewButton(0).disabled).toBe(false);
    fireEvent.click(previewButton(0));
    await waitFor(() => expect(preview).toHaveBeenCalledWith(expect.objectContaining({ guestoptin4: true })));
  });

  it('uses quoted rate before draft default and blocks while all rates are missing', () => {
    const { client, preview } = paneClient();
    const draft = hrdavDraft();
    const group: StayGroupRequirement = { ...g1, quantity: 1, quotedRateCode: 'Q-HRDAV' };
    const view = (current: BookingDraftReady, selected: StayGroupRequirement) => (
      <BookingCards draft={current} groups={[selected]} paneSave={client} propertyCode={HRDAV_PROPERTY_CODE}
        contact={CARD_CONTACT} confirmation={CARD_CONFIRMATION} />
    );
    const { unmount } = render(view(draft, group));
    expect((screen.getByLabelText('Rate plan') as unknown as HTMLSelectElement).value).toBe('Q-HRDAV');
    fireEvent.click(previewButton(0));
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ ratePlan: 'Q-HRDAV' }));
    unmount();

    const loading = hrdavDraft();
    delete loading.draft.rooms[0]!.request.ratePlan;
    render(view(loading, { ...group, quotedRateCode: undefined, rateCode: undefined }));
    expect((screen.getByLabelText('Rate plan') as unknown as HTMLSelectElement).value).toBe('');
    expect(screen.getByText(/rates loading/i)).toBeDefined();
    expect(previewButton(0).disabled).toBe(true);
    expect(bookButton(0).disabled).toBe(true);
  });

  it('stops the batch after a refused first room', async () => {
    const { client, commit } = paneClient();
    commit.mockResolvedValueOnce({ status: 'refused', reason: 'refused_save_blank_required' });
    render(<BookingCards draft={draftReady()} paneSave={client} contact={CARD_CONTACT} confirmation={CARD_CONFIRMATION} />);
    pickRoomChoices(0);
    pickRoomChoices(1);
    fireEvent.click(previewButton(0));
    fireEvent.click(previewButton(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Book this stay' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Book this stay' }));
    await screen.findByText(/HMS still has a blank required field/i);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

describe('booking card marks guest details for the preview gate (H6b)', () => {
  it('marks the guest names, the booking summary and the HMS confirmation with data-pii', async () => {
    const { client } = paneClient();
    const { container } = render(<BookingCards draft={draftReady()} paneSave={client} />);
    expect(unmaskedPii(container, ['Smith', 'Doe'])).toEqual([]);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    expect((await screen.findByText(JOHN_SMITH_PREVIEW)).hasAttribute('data-pii')).toBe(true);
    fireEvent.click(bookButton(0));
    await screen.findByText('Booked in HMS – confirmation 98765-1');
    expect(unmaskedPii(container, ['Smith', 'Doe', '98765-1'])).toEqual([]);
  });
});

describe('booking card pane save', () => {
  it('keeps Preview out while the server flag is off and shows a disabled writes-off create', () => {
    render(<BookingCards draft={draftReady()} />);
    expect(screen.queryAllByRole('button', { name: 'Preview in HMS' })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Book in HMS' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create provisional booking' })).toBeNull();
    const writesOff = screen.getAllByRole('button', { name: 'Booking writes are off — create in HMS' });
    expect(writesOff).toHaveLength(2);
    expect(writesOff.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.queryByText('Coming soon')).toBeNull();
  });

  it('lets staff type guest first and last name and keeps Book locked while either is empty', () => {
    const { client } = paneClient();
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    const lastName = screen.getAllByLabelText('Last name')[0] as HTMLInputElement;
    const firstName = screen.getAllByLabelText('First name')[0] as HTMLInputElement;
    expect(lastName.value).toBe('Smith');
    expect(firstName.value).toBe('John');
    pickRoomChoices(0);
    expect(previewButton(0)).toHaveProperty('disabled', false);
    fireEvent.change(firstName, { target: { value: '' } });
    expect(previewButton(0)).toHaveProperty('disabled', true);
    expect(screen.getByText('Set first name before you preview.')).toBeDefined();
    fireEvent.change(firstName, { target: { value: 'Ada' } });
    fireEvent.change(lastName, { target: { value: '   ' } });
    expect(previewButton(0)).toHaveProperty('disabled', true);
    expect(screen.getByText('Set last name before you preview.')).toBeDefined();
    fireEvent.change(lastName, { target: { value: 'Lovelace' } });
    expect(previewButton(0)).toHaveProperty('disabled', false);
  });

  it('marks HRDAV Reservation Note required and blocks preview and Book until it is filled', async () => {
    const base = draftReady();
    const draft = {
      ...base,
      draft: { ...base.draft, rooms: base.draft.rooms.slice(0, 1) },
      options: { ...base.options, requiredCreateFields: ['reservationnote'] } as BookingDraftReady['options'],
    };
    const { client } = paneClient();
    render(<BookingCards draft={draft} paneSave={client} />);
    pickRoomChoices(0);

    const reservationNote = screen.getByLabelText('Reservation note') as HTMLTextAreaElement;
    expect(reservationNote.getAttribute('aria-required')).toBe('true');
    expect(screen.getByText('(required)')).toBeDefined();
    expect(previewButton(0)).toHaveProperty('disabled', true);
    expect(bookButton(0)).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Book this stay' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Set reservation note before you preview.')).toBeDefined();

    fireEvent.change(reservationNote, { target: { value: 'Late arrival' } });
    expect(previewButton(0)).toHaveProperty('disabled', false);
    fireEvent.click(previewButton(0));
    await screen.findByText(JOHN_SMITH_PREVIEW);
    expect(bookButton(0)).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Book this stay' })).toHaveProperty('disabled', false);
  });

  it('previews with the typed guest names, not the draft request', async () => {
    const { client, preview } = paneClient();
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    pickRoomChoices(0);
    fireEvent.change(screen.getAllByLabelText('First name')[0]!, { target: { value: 'Ada' } });
    fireEvent.change(screen.getAllByLabelText('Last name')[0]!, { target: { value: 'Lovelace' } });
    fireEvent.click(previewButton(0));
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'Ada', lastName: 'Lovelace' }));
    expect(await screen.findByText(/Nava will book Ada Lovelace/)).toBeDefined();
  });

  it('prefills email source and asks for the remaining choices before Preview', () => {
    const { client, preview } = paneClient();
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    expect(fieldValues('Source of business')).toEqual(['E-Mail', 'E-Mail']);
    expect(previewButton(0)).toHaveProperty('disabled', true);
    expect(screen.getAllByText('Set track, guarantee before you preview.')).toHaveLength(2);
    pickRoomChoices(0);
    expect(previewButton(0)).toHaveProperty('disabled', false);
    expect(preview).not.toHaveBeenCalled();
  });

  it('previews a room with words while it runs, then shows the summary and unlocks Book in HMS', async () => {
    const pending = deferred<PaneStayResult>();
    const preview = vi.fn<PaneStayClient['preview']>().mockImplementation(() => pending.promise);
    const { client } = paneClient({ preview });
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({
      firstName: 'John',
      lastName: 'Smith',
      arrival: '2026-11-12',
      departure: '2026-11-14',
      adults: 1,
      sourceOfBusiness: 'E-Mail',
      roomType: 'STQN',
      ratePlan: 'TAXYZ',
      track: 'COR',
      guestoptin4: false,
      guaranteeType: 'Confirmation Received',
    }));
    expect(preview.mock.calls[0]?.[0]).not.toHaveProperty('bookingAgency');
    expect(screen.getByRole('status').textContent).toBe('Nava is filling the booking in HMS… (about 2 minutes)');
    expect(bookButton(0)).toHaveProperty('disabled', true);
    await act(async () => pending.resolve(PREVIEW_OK));
    expect(await screen.findByText(JOHN_SMITH_PREVIEW)).toBeDefined();
    expect(bookButton(0)).toHaveProperty('disabled', false);
  });

  it('opens the preview screenshot full size and closes it again', async () => {
    const { client } = paneClient();
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    // Role queries are slow on the full card DOM, so this wait is longer than the 1 s default.
    fireEvent.click(await screen.findByRole('button', { name: 'See what Nava filled in HMS' }, { timeout: 5000 }));
    expect(screen.getByRole('dialog', { name: 'See what Nava filled in HMS' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks for a new preview when a field changes after the preview', async () => {
    const { client } = paneClient();
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    await screen.findByText(JOHN_SMITH_PREVIEW);
    fireEvent.change(screen.getAllByLabelText('Track')[0]!, { target: { value: 'BAR' } });
    expect(screen.getByText('You changed the booking – preview again.')).toBeDefined();
    expect(bookButton(0)).toHaveProperty('disabled', true);
    expect(screen.queryByText(JOHN_SMITH_PREVIEW)).toBeNull();
  });

  it('restores the same work-item Stay preview after the booking card remounts without saving', async () => {
    const { client, preview, commit } = paneClient();
    const workItemId = '22222222-2222-4222-8222-222222222222';
    const host = (session: QuoteSession) => (
      <QuoteBookingHost session={session} paneSave={client} workItemId={workItemId} />
    );
    const { rerender } = render(host(bookingSessionForPreview(previewableDraft(), 1)));

    fireEvent.click(previewButton(0));
    expect(await screen.findByText(JOHN_SMITH_PREVIEW)).toBeDefined();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ workItemId, stayId: 'stay-preview-1_1' }));
    expect(commit).not.toHaveBeenCalled();

    rerender(host(bookingSessionForPreview(previewableDraft(), 2)));

    expect(await screen.findByText(JOHN_SMITH_PREVIEW)).toBeDefined();
    expect(bookButton(0)).toHaveProperty('disabled', false);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('clears a cached preview when the same work-item Stay digest changes', async () => {
    const { client, preview, commit } = paneClient();
    const workItemId = '33333333-3333-4333-8333-333333333333';
    const host = (session: QuoteSession) => (
      <QuoteBookingHost session={session} paneSave={client} workItemId={workItemId} />
    );
    const { rerender } = render(host(bookingSessionForPreview(previewableDraft(), 1)));

    fireEvent.click(previewButton(0));
    expect(await screen.findByText(JOHN_SMITH_PREVIEW)).toBeDefined();

    rerender(host(bookingSessionForPreview(previewableDraft('BAR'), 2)));

    expect(screen.queryByText(JOHN_SMITH_PREVIEW)).toBeNull();
    expect(bookButton(0)).toHaveProperty('disabled', true);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();

    rerender(host(bookingSessionForPreview(previewableDraft(), 3)));

    expect(screen.queryByText(JOHN_SMITH_PREVIEW)).toBeNull();
    expect(bookButton(0)).toHaveProperty('disabled', true);
  });

  it('does not restore a preview that resolves after a newer input remount', async () => {
    const pending = deferred<PaneStayResult>();
    const preview = vi.fn<PaneStayClient['preview']>().mockReturnValueOnce(pending.promise);
    const { client, commit } = paneClient({ preview });
    const workItemId = '44444444-4444-4444-8444-444444444444';
    const host = (session: QuoteSession) => (
      <QuoteBookingHost session={session} paneSave={client} workItemId={workItemId} />
    );
    const { rerender } = render(host(bookingSessionForPreview(previewableDraft(), 1)));

    fireEvent.click(previewButton(0));
    expect(preview).toHaveBeenCalledTimes(1);

    rerender(host(bookingSessionForPreview(previewableDraft('BAR'), 2)));
    expect(bookButton(0)).toHaveProperty('disabled', true);

    await act(async () => pending.resolve(PREVIEW_OK));
    rerender(host(bookingSessionForPreview(previewableDraft(), 3)));

    expect(screen.queryByText(JOHN_SMITH_PREVIEW)).toBeNull();
    expect(bookButton(0)).toHaveProperty('disabled', true);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('settles an invalidated preview when staff restore the original input', async () => {
    const pending = deferred<PaneStayResult>();
    const preview = vi.fn<PaneStayClient['preview']>().mockReturnValueOnce(pending.promise);
    const { client, commit } = paneClient({ preview });
    const workItemId = '55555555-5555-4555-8555-555555555555';
    render(
      <QuoteBookingHost
        session={bookingSessionForPreview(previewableDraft(), 1)}
        paneSave={client}
        workItemId={workItemId}
      />,
    );

    fireEvent.click(previewButton(0));
    fireEvent.change(screen.getAllByLabelText('Track')[0]!, { target: { value: 'BAR' } });
    fireEvent.change(screen.getAllByLabelText('Track')[0]!, { target: { value: 'COR' } });

    await act(async () => pending.resolve(PREVIEW_OK));

    expect(screen.getByText('You changed the booking – preview again.')).toBeDefined();
    expect(previewButton(0)).toHaveProperty('disabled', false);
    expect(bookButton(0)).toHaveProperty('disabled', true);
    expect(commit).not.toHaveBeenCalled();
  });

  it('keeps the running preview notice visible after staff edit the booking', async () => {
    const pending = deferred<PaneStayResult>();
    const preview = vi.fn<PaneStayClient['preview']>().mockReturnValueOnce(pending.promise);
    const { client } = paneClient({ preview });
    render(<BookingCards draft={previewableDraft()} paneSave={client} />);

    fireEvent.click(previewButton(0));
    fireEvent.change(screen.getAllByLabelText('Track')[0]!, { target: { value: 'BAR' } });

    expect(screen.getByRole('status').textContent).toBe('Nava is filling the booking in HMS… (about 2 minutes)');
    expect(screen.queryByText('You changed the booking – preview again.')).toBeNull();
    expect(previewButton(0)).toHaveProperty('disabled', true);

    await act(async () => pending.resolve(PREVIEW_OK));
  });

  it('after a save, shows only the after-save screenshot', async () => {
    const { client, screenshot } = paneClient({
      commit: async () => ({
        status: 'ok',
        outcome: 'committed',
        confirmationNumber: '98765-1',
        runId: PANE_SAVE_RUN,
        screenshots: ['before.png', 'filled.png', 'saved.png'],
      }),
    });
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    await screen.findByText(JOHN_SMITH_PREVIEW);
    fireEvent.click(bookButton(0));
    await screen.findByText('Booked in HMS – confirmation 98765-1');
    expect(await screen.findByRole('button', { name: 'See what Nava saved in HMS' })).toBeDefined();
    expect(screenshot.mock.calls.filter((call) => call[0] === PANE_SAVE_RUN).map((call) => call[1])).toEqual([
      'saved.png',
    ]);
  });

  it('after an unverified save, says Saved — check in Infor and shows the after-save screenshot', async () => {
    const { client, screenshot } = paneClient({
      commit: async () => ({
        status: 'ok',
        outcome: 'committed_unverified',
        confirmationNumber: '98765-1',
        runId: PANE_SAVE_RUN,
        screenshots: ['before.png', 'saved.png'],
      }),
    });
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    await screen.findByText(JOHN_SMITH_PREVIEW);
    fireEvent.click(bookButton(0));
    expect(await screen.findByText(PANE_SAVE_UNVERIFIED_COPY)).toBeDefined();
    expect(screen.queryByText('Booked in HMS – confirmation 98765-1')).toBeNull();
    expect(await screen.findByRole('button', { name: 'See what Nava saved in HMS' })).toBeDefined();
    expect(screenshot).toHaveBeenCalledWith(PANE_SAVE_RUN, 'saved.png');
    expect(screenshot).not.toHaveBeenCalledWith(PANE_SAVE_RUN, 'before.png');
  });

  it('warns of a saved CMS mismatch without offering a retry', async () => {
    const { client, commit } = paneClient();
    commit.mockResolvedValueOnce({
      ...COMMIT_OK,
      outcome: 'committed_unverified',
      cmsReason: 'saved_cms_mismatch',
    } as PaneStayResult & { cmsReason: string });
    render(<BookingCards draft={previewableDraft()} paneSave={client} />);
    fireEvent.click(previewButton(0));
    await waitFor(() => expect(bookButton(0).disabled).toBe(false));
    fireEvent.click(bookButton(0));
    expect(await screen.findByText('Booked, but HMS confirmation settings did not match — check CMS in HMS')).toBeDefined();
    expect(commit).toHaveBeenCalledTimes(1);
    const retry = screen.queryByRole('button', { name: 'Create provisional booking' });
    expect(!retry || (retry as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Book this stay' })).toBeNull();
  });

  it('books with the preview digest and shows the confirmation and readback screenshot', async () => {
    const { client, commit } = paneClient();
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    await screen.findByText(JOHN_SMITH_PREVIEW);
    fireEvent.click(bookButton(0));
    expect(await screen.findByText('Booked in HMS – confirmation 98765-1')).toBeDefined();
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'John', track: 'COR' }), PANE_DIGEST);
    expect(await screen.findByRole('button', { name: 'See what Nava saved in HMS' })).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Preview in HMS' })).toHaveLength(1);
  });

  it('gives the booked confirmation a Copy confirmation action that copies the number', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      const { client } = paneClient();
      render(<BookingCards draft={draftReady()} paneSave={client} />);
      pickRoomChoices(0);
      fireEvent.click(previewButton(0));
      await screen.findByText(JOHN_SMITH_PREVIEW);
      fireEvent.click(bookButton(0));
      await screen.findByText('Booked in HMS – confirmation 98765-1');
      fireEvent.click(screen.getByRole('button', { name: 'Copy confirmation' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('98765-1'));
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('freezes the source, track and guarantee choices once Book in HMS has run', async () => {
    const { client } = paneClient();
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    await screen.findByText(JOHN_SMITH_PREVIEW);
    fireEvent.click(bookButton(0));
    await screen.findByText('Booked in HMS – confirmation 98765-1');
    const [booked, other] = Array.from(document.querySelectorAll('article'));
    const bookedSelects = Array.from(booked?.querySelectorAll('select') ?? []);
    expect(bookedSelects).toHaveLength(6);
    for (const select of bookedSelects) expect(select.disabled).toBe(true);
    for (const select of Array.from(other?.querySelectorAll('select') ?? [])) expect(select.disabled).toBe(false);
  });

  it('shows the saving wait while Book in HMS runs', async () => {
    const pending = deferred<PaneStayResult>();
    const { client } = paneClient({ commit: () => pending.promise });
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    await screen.findByText(JOHN_SMITH_PREVIEW);
    fireEvent.click(bookButton(0));
    expect(screen.getByRole('status').textContent).toBe('Nava is booking this in HMS… (about 2 minutes)');
    await act(async () => pending.resolve(COMMIT_OK));
    expect(await screen.findByText('Booked in HMS – confirmation 98765-1')).toBeDefined();
  });

  it('turns a preview refusal into plain words', async () => {
    const { client } = paneClient({
      preview: async () => ({ status: 'refused', reason: 'pane_save_labtest_required' }),
    });
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    expect(await screen.findByText(PANE_SAVE_LAB_GUARD_COPY)).toBeDefined();
    expect(bookButton(0)).toHaveProperty('disabled', true);
  });

  it('turns a commit refusal into plain words and asks for a new preview', async () => {
    const { client } = paneClient({
      commit: async () => ({ status: 'refused', reason: 'osress_reader_parked' }),
    });
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    await screen.findByText(JOHN_SMITH_PREVIEW);
    fireEvent.click(bookButton(0));
    expect(
      await screen.findByText(
        "Nava couldn't confirm there's no existing booking for this guest, so it didn't save. Check HMS, then book by hand.",
      ),
    ).toBeDefined();
    // A refusal has no confirmation number, so there is nothing to open or copy.
    expect(screen.queryByRole('button', { name: 'Copy confirmation' })).toBeNull();
    expect(bookButton(0)).toHaveProperty('disabled', true);
    expect(previewButton(0)).toHaveProperty('disabled', false);
  });

  it('after an unconfirmed save, says HMS may have saved it, keeps Book locked and shows the HMS screenshot', async () => {
    const { client } = paneClient({
      commit: async () => ({
        status: 'refused',
        reason: 'pane_save_unconfirmed',
        runId: PANE_SAVE_RUN,
        screenshots: ['saved.png'],
      }),
    });
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    await screen.findByText(JOHN_SMITH_PREVIEW);
    fireEvent.click(bookButton(0));
    expect(
      await screen.findByText(
        'HMS may have saved this booking. Check HMS for John Smith 2026-11-12 – 2026-11-14 before trying again.',
      ),
    ).toBeDefined();
    expect(await screen.findByRole('button', { name: 'See what Nava saved in HMS' })).toBeDefined();
    expect(bookButton(0)).toHaveProperty('disabled', true);
    expect(previewButton(0)).toHaveProperty('disabled', false);
    expect(screen.queryByText(/Booked in HMS/)).toBeNull();
    // Only a fresh Preview unlocks Book again.
    fireEvent.click(previewButton(0));
    await screen.findByText(JOHN_SMITH_PREVIEW);
    expect(bookButton(0)).toHaveProperty('disabled', false);
  });

  it('shows the preview-failed copy when the preview call throws', async () => {
    const { client } = paneClient({
      preview: async () => {
        throw new Error('network down');
      },
    });
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    expect(await screen.findByText(PANE_PREVIEW_FAILED_COPY)).toBeDefined();
  });

  it('warns to check HMS when the book call throws after it may have saved', async () => {
    const { client } = paneClient({
      commit: async () => {
        throw new Error('socket closed');
      },
    });
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    await screen.findByText(JOHN_SMITH_PREVIEW);
    fireEvent.click(bookButton(0));
    expect(await screen.findByText(PANE_COMMIT_UNREACHABLE_COPY)).toBeDefined();
  });

  it('shows a saved confirmation on mount without booking again', async () => {
    const { client, commit, screenshot } = paneClient();
    const draft = draftReady({ rooms: [draftReady().draft.rooms[0]!] });
    render(
      <BookingCards
        draft={draft}
        groups={[{ ...g1, stayId: 's_aaaa1111' }]}
        paneSave={client}
        workItemId="11111111-1111-1111-1111-111111111111"
        savedStays={{
          s_aaaa1111_1: {
            confirmationNumber: '98765-1',
            status: 'booked',
            screenshotRef: { runId: PANE_SAVE_RUN, name: 'saved.png' },
          },
        }}
      />,
    );
    expect(screen.getByText('Booked in HMS – confirmation 98765-1')).toBeDefined();
    expect(await screen.findByRole('button', { name: 'See what Nava saved in HMS' })).toBeDefined();
    expect(commit).not.toHaveBeenCalled();
    expect(screenshot).toHaveBeenCalledWith(PANE_SAVE_RUN, 'saved.png');
    expect(screen.queryByRole('button', { name: 'Preview in HMS' })).toBeNull();
  });

  it('on mount, an unknown save tells staff to check HMS before booking again', async () => {
    const { client, commit } = paneClient();
    const draft = draftReady({ rooms: [draftReady().draft.rooms[0]!] });
    render(
      <BookingCards
        draft={draft}
        groups={[{ ...g1, stayId: 's_aaaa1111' }]}
        paneSave={client}
        savedStays={{
          s_aaaa1111_1: {
            confirmationNumber: null,
            status: 'unknown',
            screenshotRef: { runId: PANE_SAVE_RUN, name: 'saved.png' },
          },
        }}
      />,
    );
    expect(
      screen.getByText(
        'HMS may have saved this booking. Check HMS for John Smith 2026-11-12 – 2026-11-14 before trying again.',
      ),
    ).toBeDefined();
    expect(commit).not.toHaveBeenCalled();
    expect(screen.queryByText(/Booked in HMS/)).toBeNull();
  });

  it('Book this stay commits each room row and shows both confirmation numbers', async () => {
    const { client, commit } = paneClient();
    commit
      .mockResolvedValueOnce({ ...COMMIT_OK, confirmationNumber: '11111-1' })
      .mockResolvedValueOnce({ ...COMMIT_OK, confirmationNumber: '22222-1' });
    const draft = draftReady();
    draft.draft.rooms[0]!.request.childAges = [5];
    render(<BookingCards draft={draft} paneSave={client} contact={CARD_CONTACT} confirmation={CARD_CONFIRMATION} />);
    expect(screen.getAllByRole('button', { name: 'Create provisional booking' })).toHaveLength(2);
    pickRoomChoices(0);
    pickRoomChoices(1);
    fireEvent.click(previewButton(0));
    fireEvent.click(previewButton(1));
    await screen.findAllByText(/Nothing is saved until you press Create provisional booking/);
    const bookStay = screen.getByRole('button', { name: 'Book this stay' }) as HTMLButtonElement;
    await waitFor(() => expect(bookStay.disabled).toBe(false));
    fireEvent.click(bookStay);
    await screen.findByText(/Booked 2 of 2/);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[0]?.[0]).toMatchObject({ firstName: 'John', childAges: [5] });
    expect(commit.mock.calls[1]?.[0]).toMatchObject({ firstName: 'Jane' });
    expect(screen.getByText('Booked in HMS – confirmation 11111-1')).toBeDefined();
    expect(screen.getByText('Booked in HMS – confirmation 22222-1')).toBeDefined();
  });

  it('stops later room creates when the top contact changes during batch booking', async () => {
    const { client, commit } = paneClient();
    const firstCommit = deferred<PaneStayResult>();
    commit.mockReturnValueOnce(firstCommit.promise).mockResolvedValueOnce(COMMIT_OK);
    const draft = draftReady();
    let contact: StoredContact = {
      name: 'Original Booker',
      company: null,
      endClient: null,
      email: 'original@example.invalid',
      phone: null,
    };
    const view = () => <BookingCards draft={draft} paneSave={client} contact={contact} />;
    const { rerender } = render(view());
    pickRoomChoices(0);
    pickRoomChoices(1);
    fireEvent.click(previewButton(0));
    fireEvent.click(previewButton(1));
    const bookStay = screen.getByRole('button', { name: 'Book this stay' }) as HTMLButtonElement;
    await waitFor(() => expect(bookStay.disabled).toBe(false));
    fireEvent.click(bookStay);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));

    contact = { ...contact, name: 'Updated Booker' };
    rerender(view());
    await act(async () => firstCommit.resolve(COMMIT_OK));

    await waitFor(() => {
      const secondRoomName = screen.getAllByLabelText('First name')[1] as HTMLInputElement;
      expect(secondRoomName.disabled).toBe(false);
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ bookerName: 'Original Booker' }),
      PANE_DIGEST,
    );
    expect((screen.getByRole('button', { name: 'Book this stay' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('passes work item and saved Stay through QuoteBookingHost to Book', async () => {
    const { client, commit } = paneClient();
    const draft = draftReady();
    const session = quotedSession(draft);
    session.groups = [{ ...g1, stayId: 's_aaaa1111' }];
    render(
      <QuoteBookingHost
        session={session}
        paneSave={client}
        workItemId="11111111-1111-1111-1111-111111111111"
        savedStays={{
          s_aaaa1111_1: {
            confirmationNumber: 'TEST-123',
            status: 'booked',
            screenshotRef: null,
          },
        }}
      />,
    );
    expect(screen.getByText('Booked in HMS – confirmation TEST-123')).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Preview in HMS' })).toHaveLength(1);
    pickRoomChoices(1);
    fireEvent.click(previewButton(0));
    await screen.findByText(/Nothing is saved until you press Create provisional booking/);
    fireEvent.click(bookButton(0));
    await screen.findByText('Booked in HMS – confirmation 98765-1');
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        stayId: 's_aaaa1111_2',
        workItemId: '11111111-1111-1111-1111-111111111111',
      }),
      PANE_DIGEST,
    );
  });
});

describe('booking card save modes and the note fields', () => {
  it('names the Book action Create provisional booking in lab and on modes', () => {
    const lab = paneClient({ mode: () => 'lab' });
    const { unmount } = render(<BookingCards draft={draftReady()} paneSave={lab.client} />);
    expect(screen.getAllByRole('button', { name: 'Create provisional booking' })).toHaveLength(2);
    expect(screen.getByRole('note').textContent).toBe('This write is test-only. Book a real guest in HMS.');
    expect(screen.queryByRole('button', { name: 'Book (lab test only)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Book in HMS' })).toBeNull();
    unmount();
    const on = paneClient({ mode: () => 'on' });
    render(<BookingCards draft={draftReady()} paneSave={on.client} />);
    expect(screen.getAllByRole('button', { name: 'Create provisional booking' })).toHaveLength(2);
    expect(screen.queryByText('This write is test-only. Book a real guest in HMS.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Book (lab test only)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Book in HMS' })).toBeNull();
  });

  it('shows copy buttons and a disabled writes-off create when the server mode is off', () => {
    const { client, preview, commit } = paneClient({ mode: () => 'off' });
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    expect(screen.queryAllByRole('button', { name: 'Preview in HMS' })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Book in HMS' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create provisional booking' })).toBeNull();
    const writesOff = screen.getAllByRole('button', { name: 'Booking writes are off — create in HMS' });
    expect(writesOff).toHaveLength(2);
    expect(writesOff.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.queryByText('This write is test-only. Book a real guest in HMS.')).toBeNull();
    expect(screen.queryByText('Coming soon')).toBeNull();
    expect(preview).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: 'Copy Reservation note for Standard Queen ×2' })).toHaveLength(2);
  });

  it('previews and books a child room with its age, and invalidates preview after an age edit', async () => {
    const { client, preview, commit } = paneClient();
    const draft = previewableDraft();
    draft.draft.rooms[0]!.request.childAges = [5];
    render(<BookingCards draft={draft} paneSave={client} contact={CARD_CONTACT} confirmation={CARD_CONFIRMATION} />);

    expect(screen.queryByText('Bookings with children: enter in HMS for now')).toBeNull();
    expect(bookButton(0)).toBeDefined();
    const age = screen.getByLabelText(/child age 1/i) as HTMLInputElement;
    expect(age.value).toBe('5');
    fireEvent.click(previewButton(0));
    await waitFor(() => expect(bookButton(0).disabled).toBe(false));
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ childAges: [5] }));

    fireEvent.change(age, { target: { value: '6' } });
    expect(bookButton(0).disabled).toBe(true);
    fireEvent.click(previewButton(0));
    await waitFor(() => expect(bookButton(0).disabled).toBe(false));
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ childAges: [6] }));
    fireEvent.change(age, { target: { value: '5' } });
    fireEvent.click(previewButton(0));
    await waitFor(() => expect(bookButton(0).disabled).toBe(false));
    fireEvent.click(bookButton(0));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ childAges: [5] }), PANE_DIGEST);
  });

  it('uses the latest top contact for create preview, not the draft or mounted contact copy', () => {
    const { client, preview } = paneClient();
    const draft = draftReady({ rooms: [draftReady().draft.rooms[0]!] });
    draft.draft.rooms[0]!.request.bookerName = 'Old draft name';
    draft.draft.rooms[0]!.request.bookerEmail = 'old-draft@example.invalid';
    const contact = {
      name: 'Old top contact',
      company: null,
      endClient: null,
      email: 'old-top@example.invalid',
      phone: null,
    };
    const latestContact = { ...contact, name: 'Updated top contact', email: 'updated@example.invalid' };
    const { rerender } = render(<BookingCards draft={draft} paneSave={client} contact={contact} />);
    pickRoomChoices(0);
    rerender(<BookingCards draft={draft} paneSave={client} contact={latestContact} />);

    fireEvent.click(previewButton(0));

    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({ bookerName: 'Updated top contact', bookerEmail: 'updated@example.invalid' }),
    );
    expect(screen.queryByLabelText('Booker name')).toBeNull();
    expect(screen.queryByLabelText('Booker contact (email)')).toBeNull();
  });

  it('uses the edited top contact for create preview', () => {
    const { client, preview } = paneClient();
    let contact: StoredContact = {
      name: 'Original Booker',
      company: null,
      endClient: null,
      email: 'original@example.invalid',
      phone: null,
    };
    const draft = draftReady({ rooms: [draftReady().draft.rooms[0]!] });
    const view = () => (
      <>
        <ContactBlock
          contact={contact}
          onEdit={(field, value) => {
            contact = { ...contact, [field]: value };
          }}
        />
        <BookingCards draft={draft} paneSave={client} contact={contact} />
      </>
    );
    const { rerender } = render(view());
    pickRoomChoices(0);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Booker' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'updated@example.invalid' } });
    rerender(view());

    fireEvent.click(previewButton(0));

    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({ bookerName: 'Updated Booker', bookerEmail: 'updated@example.invalid' }),
    );
  });

  it('sends create-only edits with the top contact and invalidates preview when a note changes', async () => {
    const { client, preview } = paneClient();
    const contact = {
      name: 'Ann Booker',
      company: null,
      endClient: null,
      email: 'ann@example.invalid',
      phone: null,
    };
    render(<BookingCards draft={draftReady()} paneSave={client} contact={contact} />);
    pickRoomChoices(0);
    fireEvent.change(screen.getAllByLabelText('Organization')[0]!, { target: { value: '  Bidvest Bank ' } });
    fireEvent.change(screen.getAllByLabelText('Reservation note')[0]!, { target: { value: 'Pay by EFT' } });
    fireEvent.click(previewButton(0));
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({
        organization: { name: 'Bidvest Bank' },
        reservationNote: 'Pay by EFT',
        bookerName: 'Ann Booker',
        bookerEmail: 'ann@example.invalid',
      }),
    );
    expect(screen.queryByLabelText('Booker name')).toBeNull();
    expect(screen.queryByLabelText('Booker contact (email)')).toBeNull();
    await screen.findByText(JOHN_SMITH_PREVIEW);
    fireEvent.change(screen.getAllByLabelText('Reservation note')[0]!, { target: { value: 'Early arrival' } });
    expect(screen.getByText('You changed the booking – preview again.')).toBeDefined();
    expect(bookButton(0)).toHaveProperty('disabled', true);
  });

  it('caps the reservation note at 2000 characters and rejects an overlong organization', () => {
    const { client, preview } = paneClient();
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    expect((screen.getAllByLabelText('Reservation note')[0] as HTMLTextAreaElement).maxLength).toBe(2000);
    pickRoomChoices(0);
    fireEvent.change(screen.getAllByLabelText('Organization')[0]!, { target: { value: 'A'.repeat(101) } });
    expect(previewButton(0)).toHaveProperty('disabled', true);
    expect(screen.getByText('Set organization name (100 characters at most) before you preview.')).toBeDefined();
    expect(preview).not.toHaveBeenCalled();
  });

  it('prefills Book Reservation note from the generated stay note and keeps a dirty staff edit', () => {
    const draft = draftReady({ rooms: [draftReady().draft.rooms[0]!] });
    const session = sessionWithGeneratedNote(draft);
    const note = reservationNoteForGroup(session, HRDAV_PROPERTY_CODE, 'g1');
    expect(note).toBeTruthy();

    const view = (current: QuoteSession) => (
      <BookingCards
        draft={draft}
        groups={current.groups}
        session={current}
        propertyCode={HRDAV_PROPERTY_CODE}
      />
    );
    const { rerender } = render(view(session));
    const field = screen.getByLabelText('Reservation note') as HTMLTextAreaElement;
    expect(field.value).toBe(note);

    fireEvent.change(field, { target: { value: 'Staff override' } });
    expect(field.value).toBe('Staff override');

    const changed = sessionWithBoardRoomLabel(session, 'Deluxe Twin');
    const nextNote = reservationNoteForGroup(changed, HRDAV_PROPERTY_CODE, 'g1');
    expect(nextNote).not.toBe(note);
    rerender(view(changed));
    expect((screen.getByLabelText('Reservation note') as HTMLTextAreaElement).value).toBe('Staff override');

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate reservation note' }));
    expect((screen.getByLabelText('Reservation note') as HTMLTextAreaElement).value).toBe(nextNote);
  });
});

describe('pane save helpers', () => {
  it('gives plain words with a next step for every refusal the server can return', () => {
    const generic = paneRefusalMessage('not_a_known_code');
    for (const reason of [
      'pane_save_flag_off',
      'pane_save_labtest_required',
      'pane_save_arrival_2027_required',
      'pane_save_property_mismatch',
      'pane_save_children_unsupported',
      'pane_save_adults_required',
      'osress_reader_parked',
      'osress_duplicate',
      'pane_save_preview_required',
      'pane_save_digest_mismatch',
      'pane_save_lock_unavailable',
      'refused_lock_busy',
      'refused_save_blank_required',
      'pane_save_unconfirmed',
    ]) {
      expect(paneRefusalMessage(reason)).not.toBe(generic);
    }
    expect(paneRefusalMessage('pane_save_labtest_required')).toBe(PANE_SAVE_LAB_GUARD_COPY);
  });

  const johnSmith = { firstName: 'John', lastName: 'Smith', arrival: '2026-11-12', departure: '2026-11-14' };

  it('says HMS may have saved the booking, with the guest and dates to check', () => {
    expect(paneUnconfirmedMessage(johnSmith)).toBe(
      'HMS may have saved this booking. Check HMS for John Smith 2026-11-12 – 2026-11-14 before trying again.',
    );
    expect(paneRefusalMessage(PANE_SAVE_UNCONFIRMED_REASON, johnSmith)).toBe(paneUnconfirmedMessage(johnSmith));
    expect(PANE_SAVE_UNCONFIRMED_REASON).toBe('pane_save_unconfirmed');
  });

  it('maps a refused unconfirmed save to that copy and keeps the run for its screenshot', () => {
    expect(
      commitOutcome(
        { status: 'refused', reason: PANE_SAVE_UNCONFIRMED_REASON, runId: 'run-1', screenshots: ['saved.png'] },
        johnSmith,
      ),
    ).toEqual({
      ok: false,
      message: paneUnconfirmedMessage(johnSmith),
      runId: 'run-1',
      screenshots: ['saved.png'],
    });
  });

  it('never reads an answer without a booking number as a plain failure', () => {
    for (const result of [
      { status: 'ok' as const, outcome: 'save_failed', confirmationNumber: '' },
      { status: 'ok' as const, outcome: 'save_unconfirmed', confirmationNumber: '' },
      { status: 'ok' as const, outcome: 'execution_failure', confirmationNumber: '' },
    ]) {
      const outcome = commitOutcome(result, johnSmith);
      expect(outcome).toMatchObject({ ok: false, message: paneUnconfirmedMessage(johnSmith) });
      expect(outcome.ok ? '' : outcome.message).not.toMatch(/failed|did not save|nothing was saved/i);
    }
    expect(commitOutcome({ status: 'ok', outcome: 'committed', confirmationNumber: '61143613-1' })).toMatchObject({
      ok: true,
      confirmationNumber: '61143613-1',
    });
    expect(
      commitOutcome({
        status: 'ok',
        outcome: 'committed_unverified',
        confirmationNumber: '61143613-1',
        screenshots: ['before.png', 'saved.png'],
      }),
    ).toEqual({
      ok: true,
      confirmationNumber: '61143613-1',
      runId: undefined,
      screenshots: ['before.png', 'saved.png'],
      unverified: true,
    });
  });

  it('names the fields still missing from a room', () => {
    const request = {
      firstName: 'John',
      lastName: '',
      arrival: '2026-11-12',
      departure: '2026-11-14',
      adults: 1,
      roomType: 'STQN',
      ratePlan: 'TAXYZ',
    };
    expect(
      paneStayInputForRoom(request, { roomType: 'STQN', track: '', sourceOfBusiness: 'E-Mail', guaranteeType: '' }),
    ).toEqual({
      stay: null,
      missing: ['last name', 'track', 'guarantee'],
    });
  });

  it('takes typed guest names over the draft request', () => {
    const request = {
      firstName: 'John',
      lastName: 'Smith',
      arrival: '2026-11-12',
      departure: '2026-11-14',
      adults: 1,
      roomType: 'STQN',
      ratePlan: 'TAXYZ',
    };
    const built = paneStayInputForRoom(request, {
      roomType: 'STQN',
      track: 'BAR',
      sourceOfBusiness: 'E-Mail',
      guaranteeType: '6pm Release',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    expect(built.stay?.firstName).toBe('Ada');
    expect(built.stay?.lastName).toBe('Lovelace');
    expect(
      paneStayInputForRoom(request, {
        roomType: 'STQN',
        track: 'BAR',
        sourceOfBusiness: 'E-Mail',
        guaranteeType: '6pm Release',
        firstName: '',
        lastName: 'Lovelace',
      }),
    ).toEqual({ stay: null, missing: ['first name'] });
  });

  it('takes a typed rate code when the draft request has none', () => {
    const request = {
      firstName: 'John',
      lastName: 'Smith',
      arrival: '2026-11-12',
      departure: '2026-11-14',
      adults: 1,
    };
    const built = paneStayInputForRoom(request, {
      roomType: 'STQN',
      track: 'BAR',
      sourceOfBusiness: 'E-Mail',
      guaranteeType: '6pm Release',
      ratePlan: 'BARRO',
    });
    expect(built.stay?.ratePlan).toBe('BARRO');
  });

  it('refuses an empty or whitespace rate code even when the draft has one', () => {
    const request = {
      firstName: 'John',
      lastName: 'Smith',
      arrival: '2026-11-12',
      departure: '2026-11-14',
      adults: 1,
      ratePlan: 'BCO1B',
    };
    const choice = {
      roomType: 'STQN',
      track: 'BAR',
      sourceOfBusiness: 'E-Mail',
      guaranteeType: '6pm Release',
    };
    expect(paneStayInputForRoom(request, { ...choice, ratePlan: '' })).toEqual({
      stay: null,
      missing: ['rate code'],
    });
    expect(paneStayInputForRoom(request, { ...choice, ratePlan: '  ' })).toEqual({
      stay: null,
      missing: ['rate code'],
    });
  });

  it('reads the server flag, and reads off when the client has no brain router', async () => {
    await expect(
      readPaneSaveFlag({ brain: { getCapabilities: { query: async () => ({ paneSave: true }) } } }),
    ).resolves.toBe(true);
    await expect(readPaneSaveFlag({})).resolves.toBe(false);
  });

  it('maps the server capabilities to a mode; a server with no mode name reads as lab', () => {
    expect(paneSaveModeOf(null)).toBe('off');
    expect(paneSaveModeOf({ paneSave: false, paneSaveMode: 'off' })).toBe('off');
    expect(paneSaveModeOf({ paneSave: true })).toBe('lab');
    expect(paneSaveModeOf({ paneSave: true, paneSaveMode: 'lab' })).toBe('lab');
    expect(paneSaveModeOf({ paneSave: true, paneSaveMode: 'on' })).toBe('on');
    expect(
      paneSaveModeOf({
        paneSave: true,
        paneSaveMode: 'on',
        paneWrite: { create: 'lab' },
      }),
    ).toBe('lab');
    expect(
      paneSaveModeOf({
        paneSave: false,
        paneSaveMode: 'off',
        paneWrite: { create: 'off' },
      }),
    ).toBe('off');
  });

  it('remembers the mode on the tRPC client it read the flag through', async () => {
    const trpc = { brain: { getCapabilities: { query: async () => ({ paneSave: true, paneSaveMode: 'on' }) } } };
    expect(paneStayFromTrpc(trpc).mode?.()).toBeNull();
    await expect(readPaneSaveFlag(trpc)).resolves.toBe(true);
    expect(paneStayFromTrpc(trpc).mode?.()).toBe('on');
  });

  it('keeps the mode on the real tRPC client shape, a Proxy over a function', async () => {
    // createFlatProxy in @trpc/server returns new Proxy(noop, ...), so typeof is 'function'.
    const query = async () => ({ paneSave: true, paneSaveMode: 'lab' });
    const trpc = new Proxy(() => {}, {
      get: (_target, name) => (name === 'brain' ? { getCapabilities: { query } } : undefined),
    });
    expect(typeof trpc).toBe('function');
    await expect(readPaneSaveFlag(trpc)).resolves.toBe(true);
    expect(paneStayFromTrpc(trpc).mode?.()).toBe('lab');
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
          id: 'staff-edited-group',
          arrivalDate: '2026-11-12',
          departureDate: '2026-11-14',
          quantity: 2,
          adults: 1,
          childrenAges: [],
          board: 'room_only',
          specialRequests: [],
          fields: {},
        },
      ])[0]?.guestNames,
    ).toEqual(['John Smith', 'Jane Doe']);
  });

  it('carries whether the reused quote already charged the once-per-quote extras', async () => {
    const ready = (onceExtras?: boolean) => async () => ({
      status: 'ready' as const,
      draft: { rooms: [] } as unknown as BookingDraftReady['draft'],
      options: {} as BookingDraftReady['options'],
      messageId: 'mail-1',
      selectionEpoch: 1,
      inputRevision: 1,
      revisionRef: 'rev-1',
      workflowRunId: 'run-1',
      totalMinor: 100,
      currency: 'ZAR',
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-14',
      roomCode: 'STQN',
      rateCode: 'BAR',
      board: 'bb' as const,
      ...(onceExtras === undefined ? {} : { onceExtras }),
    });
    const args = {
      source,
      workflowRunId: 'run-1',
      revisionRef: 'rev-1',
      threadId: 'thread-1',
      messageId: 'mail-1',
      selectionEpoch: 1,
      inputRevision: 1,
      analysis: luna,
    };
    const withShuttle = await bindUsePriorQuoteForBooking({ ...args, mutate: ready(true) });
    expect(withShuttle.status === 'ok' && withShuttle.payload.onceExtras).toBe(true);
    const older = await bindUsePriorQuoteForBooking({ ...args, mutate: ready() });
    expect(older.status === 'ok' && older.payload.onceExtras).toBe(false);
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
    expect(EXPIRED_PRIOR_QUOTE_REQUOTE_LABEL).toBe('Re-quote this stay');
    expect(expiredPriorQuoteToastMessage()).toMatch(/expired/i);
  });

  it('prefers a matching expired quote over an unrelated stay mismatch', () => {
    expect(
      expiredPriorQuoteNotice(['scope_mismatch', 'expired'], {
        workflowRunId: 'run-old',
        revisionRef: 'rev-old',
      }),
    ).toBe('requote');
    expect(expiredPriorQuoteNotice(['scope_mismatch'], null)).toBe('mismatch');
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

  it('restores stored extras onto the re-quote header when staff has not edited stays', () => {
    const { header } = buildExpiredPriorRequoteBindArgs({
      stored: {
        ...stored,
        dinnerAllowanceMinor: 12_500,
        shuttleRequested: true,
        shuttleMinor: 45_000,
      },
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
    expect(header).toMatchObject({
      dinnerAllowanceMinor: 12_500,
      shuttleRequested: true,
      shuttleMinor: 45_000,
    });
  });

  it('restores the new extras and note onto the re-quote header when staff has not edited stays', () => {
    const { header } = buildExpiredPriorRequoteBindArgs({
      stored: {
        ...stored,
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
      },
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
    expect(header).toMatchObject({
      dinnerAllowanceLabel: 'food only',
      lunchAllowanceMinor: 20_000,
      officeTransferMinor: 20_000,
      officeTransferDays: 4,
      shuttleTrips: 2,
      other: { label: 'Parking', amountMinor: 30_000, unit: 'item' },
      notes: 'Late check-in',
    });
  });

  it('restores a dinner add-on unit and remaps its fallback group onto the re-quote rows', () => {
    const { groups, header } = buildExpiredPriorRequoteBindArgs({
      stored: {
        ...stored,
        dinnerAllowanceMinor: 17_500,
        dinnerAllowanceUnit: 'per_room_per_night',
        dinnerAllowanceLabel: 'Set menu',
        dinnerAllowanceGroupIds: ['prior-g1'],
      },
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

    expect(header).toMatchObject({
      dinnerAllowanceMinor: 17_500,
      dinnerAllowanceUnit: 'per_room_per_night',
      dinnerAllowanceLabel: 'Set menu',
      dinnerAllowanceGroupIds: [groups[0]!.id],
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
      propertyCode: HRCEN_PROPERTY_CODE,
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

describe('booking card HMS notes copy', () => {
  const CONTACT = { name: 'Jane Smith', company: 'Acme Travel', endClient: null, email: null, phone: null };

  function stubClipboard() {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    return writeText;
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('gives each room its own HMS notes copy button', () => {
    render(<BookingCards draft={draftReady()} />);
    expect(screen.getAllByRole('button', { name: 'Copy for HMS notes' })).toHaveLength(2);
  });

  it('uses the latest top contact and keeps Organization as a create-only field', async () => {
    const writeText = stubClipboard();
    const draft = draftReady();
    draft.draft.rooms[0]!.request.bookerName = 'Old draft name';
    const { rerender } = render(<BookingCards draft={draft} contact={CONTACT} />);

    fireEvent.change(screen.getAllByLabelText('Organization')[0]!, { target: { value: 'Bidvest Bank' } });
    rerender(
      <BookingCards
        draft={draft}
        contact={{ ...CONTACT, name: 'Pat Jones' }}
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy for HMS notes' })[0]!);

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(['Booker: Pat Jones', 'Company: Bidvest Bank', 'Rate: TAXYZ'].join('\n')),
    );
    expect(screen.queryByLabelText('Booker name')).toBeNull();
  });

  it('the HMS notes retain the selected board and approval note, then add the confirmation', async () => {
    const writeText = stubClipboard();
    const { client } = paneClient();
    const draft = draftReady();
    draft.draft.rooms[0]!.board = 'bb';
    const rowPrice = { source: 'override' as const, rateCode: 'NCOR1B', amountMinor: 185000, note: 'Thandi approved' };
    render(
      <BookingCards
        draft={draft}
        groups={[{ ...g1, board: 'dinner_bb', rateCode: 'BARRO', specialRequests: ['Cot'], rowPrice }]}
        paneSave={client}
        contact={CONTACT}
      />,
    );
    const quoted = [
      'Booker: Jane Smith',
      'Company: Acme Travel',
      'Special requests: Cot',
      'Discount authorised by: Thandi approved',
      'Rate: NCOR1B R1850.00 per night, Bed & breakfast',
    ];

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy for HMS notes' })[0]!);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(quoted.join('\n')));

    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    await screen.findByText(/Nava will book John Smith .*rate BARRO/);
    fireEvent.click(bookButton(0));
    await screen.findByText('Booked in HMS – confirmation 98765-1');

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy for HMS notes' })[0]!);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith([...quoted, 'Confirmation: 98765-1'].join('\n')));
  });
});
