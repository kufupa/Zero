/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookingCards } from '../components/quote-workflow/booking-card';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
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
  paneUnconfirmedMessage,
  PANE_COMMIT_UNREACHABLE_COPY,
  PANE_PREVIEW_FAILED_COPY,
  PANE_SAVE_LAB_GUARD_COPY,
  PANE_SAVE_UNCONFIRMED_REASON,
  paneStayInputForRoom,
  readPaneSaveFlag,
  type PaneStayClient,
  type PaneStayResult,
} from '../lib/quote-workflow/pane-stay-bind';
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
    expect(screen.getAllByText('STQN')).toHaveLength(2);
    expect(screen.getAllByText('TAXYZ')).toHaveLength(2);
    expect(screen.getByText('Smith')).toBeDefined();
    expect(screen.getByText('Doe')).toBeDefined();
    expect(screen.getAllByRole('button', { name: /^Copy Adults for room \d$/ })).toHaveLength(2);
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

  it('disables Save with the coming-next copy', () => {
    render(<QuoteWorkflowPanel session={quotedSession()} />);
    const save = screen.getByRole('button', { name: /save/i });
    expect(save).toHaveProperty('disabled', true);
    expect(
      screen.getByText('Saving from this pane is coming soon. For now, copy each field into HMS.'),
    ).toBeDefined();
  });

  it('disables Preview and Commit while pane save stays behind the flag', () => {
    render(<QuoteWorkflowPanel session={quotedSession()} />);
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Book in HMS' })).toHaveProperty('disabled', true);
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
  });

  it('opens with a plain-English note that saving in HMS is off', () => {
    render(<BookingCards draft={draftReady()} />);
    expect(
      screen.getByText(
        'Saving in HMS from here is switched off for now. Click Copy next to each field, then paste it into HMS Guest Stay.',
      ),
    ).toBeDefined();
  });

  it('copies a field value to the clipboard and shows Copied for about 1.5 seconds', async () => {
    const writeText = stubClipboard();
    vi.useFakeTimers();
    render(<BookingCards draft={draftReady()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Arrival for room 1' }));
    expect(writeText).toHaveBeenCalledWith('2026-11-12');
    await flushClipboard();
    expect(screen.getByRole('button', { name: 'Copied Arrival for room 1' })).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByRole('button', { name: 'Copy Arrival for room 1' })).toBeDefined();
  });

  it('copies the track the staff picked, and stays disabled until one is picked', () => {
    const writeText = stubClipboard();
    render(<BookingCards draft={draftReady()} />);
    expect(screen.getByRole('button', { name: 'Copy Track for room 1' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getAllByLabelText('Track')[0]!, { target: { value: 'COR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy Track for room 1' }));
    expect(writeText).toHaveBeenCalledWith('COR');
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
const JOHN_SMITH_PREVIEW = `Luna will book John Smith for 2026-11-12 – 2026-11-14, 1 room, rate TAXYZ. Nothing is saved until you press Book in HMS.`;

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
  const client: PaneStayClient = { preview, commit, screenshot, ...overrides };
  return { client, preview, commit, screenshot };
}

// Room 1 has no track, source or guarantee until the staff pick them.
function pickRoomChoices(index: number) {
  fireEvent.change(screen.getAllByLabelText('Track')[index]!, { target: { value: 'COR' } });
  fireEvent.change(screen.getAllByLabelText('Source of business')[index]!, { target: { value: 'E-Mail' } });
  fireEvent.change(screen.getAllByLabelText('Guarantee')[index]!, { target: { value: 'Confirmation Received' } });
}

function previewButton(index: number): HTMLButtonElement {
  return screen.getAllByRole('button', { name: 'Preview in HMS' })[index] as HTMLButtonElement;
}

function bookButton(index: number): HTMLButtonElement {
  return screen.getAllByRole('button', { name: 'Book in HMS' })[index] as HTMLButtonElement;
}

describe('booking card pane save', () => {
  it('keeps Preview in HMS out of the card while the server flag is off', () => {
    render(<BookingCards draft={draftReady()} />);
    expect(screen.queryAllByRole('button', { name: 'Preview in HMS' })).toHaveLength(0);
  });

  it('asks for the missing choices before Preview in HMS can run', () => {
    const { client, preview } = paneClient();
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    expect(previewButton(0)).toHaveProperty('disabled', true);
    expect(screen.getAllByText('Set source of business, track, guarantee before you preview.')).toHaveLength(2);
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
    expect(preview).toHaveBeenCalledWith({
      firstName: 'John',
      lastName: 'Smith',
      arrival: '2026-11-12',
      departure: '2026-11-14',
      adults: 1,
      sourceOfBusiness: 'E-Mail',
      roomType: 'STQN',
      ratePlan: 'TAXYZ',
      track: 'COR',
      guaranteeType: 'Confirmation Received',
    });
    expect(screen.getByRole('status').textContent).toBe('Luna is filling the booking in HMS… (about 2 minutes)');
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
    fireEvent.click(await screen.findByRole('button', { name: 'See what Luna filled in HMS' }));
    expect(screen.getByRole('dialog', { name: 'See what Luna filled in HMS' })).toBeDefined();
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

  it('books with the preview digest and shows the confirmation and readback screenshot', async () => {
    const { client, commit } = paneClient();
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    await screen.findByText(JOHN_SMITH_PREVIEW);
    fireEvent.click(bookButton(0));
    expect(await screen.findByText('Booked in HMS – confirmation 98765-1')).toBeDefined();
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'John', track: 'COR' }), PANE_DIGEST);
    expect(await screen.findByRole('button', { name: 'See what Luna saved in HMS' })).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Preview in HMS' })).toHaveLength(1);
  });

  it('shows the saving wait while Book in HMS runs', async () => {
    const pending = deferred<PaneStayResult>();
    const { client } = paneClient({ commit: () => pending.promise });
    render(<BookingCards draft={draftReady()} paneSave={client} />);
    pickRoomChoices(0);
    fireEvent.click(previewButton(0));
    await screen.findByText(JOHN_SMITH_PREVIEW);
    fireEvent.click(bookButton(0));
    expect(screen.getByRole('status').textContent).toBe('Luna is booking this in HMS… (about 2 minutes)');
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
        "Luna couldn't confirm there's no existing booking for this guest, so it didn't save. Check HMS, then book by hand.",
      ),
    ).toBeDefined();
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
    expect(await screen.findByRole('button', { name: 'See what Luna saved in HMS' })).toBeDefined();
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
});

describe('pane save helpers', () => {
  it('gives plain words with a next step for every refusal the server can return', () => {
    const generic = paneRefusalMessage('not_a_known_code');
    for (const reason of [
      'pane_save_flag_off',
      'pane_save_labtest_required',
      'pane_save_arrival_2027_required',
      'pane_save_property_mismatch',
      'osress_reader_parked',
      'osress_duplicate',
      'pane_save_preview_required',
      'pane_save_digest_mismatch',
      'pane_save_lock_unavailable',
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
    expect(paneStayInputForRoom(request, { track: '', sourceOfBusiness: 'E-Mail', guaranteeType: '' })).toEqual({
      stay: null,
      missing: ['last name', 'track', 'guarantee'],
    });
  });

  it('reads the server flag, and reads off when the client has no brain router', async () => {
    await expect(
      readPaneSaveFlag({ brain: { getCapabilities: { query: async () => ({ paneSave: true }) } } }),
    ).resolves.toBe(true);
    await expect(readPaneSaveFlag({})).resolves.toBe(false);
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
