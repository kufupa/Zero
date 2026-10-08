/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmendLookupPanel } from '../components/quote-workflow/amend-lookup-panel';
import {
  AMEND_FIND_COPY,
  amendDiffs,
  amendFindClientFromTrpc,
  runHmsFind,
  type AmendFindClient,
  type FindStayReply,
  type StayRecordWire,
} from '../lib/quote-workflow/amend-find';
import type { CancelRun } from '../lib/quote-workflow/amend-cancel';
import { amendmentOf, initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import type { QuoteAmendment, QuoteSession } from '../lib/quote-workflow/types';

// brain.getCapabilities answers with this flag. Tests set it before rendering.
const capabilities = vi.hoisted(() => ({ paneSave: false }));

afterEach(() => {
  cleanup();
  capabilities.paneSave = false;
});

const THREAD = 'thread-7';
const CONFIRMATION = '57291630-1';
const RUN_ID = '3f2c9a1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
const DIGEST = 'ab'.repeat(32);
const NO_SHOT = { status: 'unavailable', reason: 'screenshot_unavailable' };
const SHOT_PNG = 'data:image/png;base64,iVBORw0KGgo=';
const NEVER_SETTLES = () => new Promise<never>(() => {});

const AMEND: QuoteAmendment = {
  kind: 'amend',
  confirmationNumber: CONFIRMATION,
  guestLastName: 'Mokoena',
  arrival: '2026-10-12',
  departure: '2026-10-14',
  requestedChange: 'Extend the stay by two nights',
};

const CANCEL: QuoteAmendment = {
  ...AMEND,
  kind: 'cancel',
  arrival: '2027-09-14',
  departure: '2027-09-16',
  requestedChange: null,
};

function sessionWith(amendment: QuoteAmendment | null, threadId: string | null = THREAD): QuoteSession {
  let session = reduceQuoteSession(initialQuoteSession(), {
    type: 'selection',
    binding: {
      transportId: 't1',
      mailboxEmail: 'centurion@legacyhotels.co.za',
      storeId: 'store',
      folderEntryId: 'inbox',
      entryId: 'e1',
      selectionEpoch: 7,
      scopeEpoch: 1,
    },
  });
  session = reduceQuoteSession(session, {
    type: 'analysis_ready',
    analysis: { intent: 'other', groups: [], secondaryAsks: [], alternatives: [], amendment },
  });
  if (threadId) {
    session = reduceQuoteSession(session, {
      type: 'staff_source_ready',
      source: { messageId: 'msg-1', threadId, sourceHash: 'a'.repeat(64) },
    });
  }
  return session;
}

/** One Guest Stay as findStay returns it. Override any field; the defaults are a booked, rated stay. */
function stayRecord(overrides: Partial<StayRecordWire> = {}): StayRecordWire {
  return {
    status: 'Reserved',
    confirmation: CONFIRMATION,
    lastName: 'Mokoena',
    firstName: 'Thabo',
    arrival: '2026-10-12',
    departure: '2026-10-13',
    nights: 1,
    adults: 1,
    children: 0,
    roomType: 'DLXKNG',
    ratePlan: 'BAR',
    mealPlan: 'Bed & breakfast',
    averageRate: '1360.00',
    grandTotal: 'R1 360,00',
    balance: '0.00',
    sourceOfBusiness: null,
    guaranteeType: null,
    bookingAgency: null,
    organization: null,
    ...overrides,
  };
}

function found(stay: Partial<StayRecordWire> = {}, screenshots: string[] = ['record.png', 'panel.png']): FindStayReply {
  return { outcome: 'found', reason: null, stay: stayRecord(stay), screenshots, runId: RUN_ID };
}

const NOT_FOUND: FindStayReply = { outcome: 'not_found', reason: null, stay: null, screenshots: [], runId: null };
const AMBIGUOUS: FindStayReply = { outcome: 'ambiguous', reason: null, stay: null, screenshots: [], runId: null };

function refusal(outcome: string): FindStayReply {
  return { outcome, reason: null, stay: null, screenshots: [], runId: null };
}

/** The paneStayLookup routes and the capability route, as the panel reads them off the tRPC client. */
function lookupTrpc(findStay: ReturnType<typeof vi.fn>, shot: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(NO_SHOT)) {
  return {
    paneStayLookup: { findStay: { mutate: findStay }, screenshot: { query: shot } },
    brain: { getCapabilities: { query: async () => ({ paneSave: capabilities.paneSave }) } },
  };
}

/** Staff press the find button. The panel never looks up HMS on its own. */
function pressFind() {
  fireEvent.click(screen.getByRole('button', { name: 'Find this booking in HMS' }));
}

function cancelRun(overrides: Partial<CancelRun> = {}): CancelRun {
  return {
    outcome: 'execution_failure',
    statusBefore: null,
    statusAfter: null,
    reasons: [],
    penaltyText: null,
    screenshots: [],
    runId: null,
    previewDigest: null,
    ...overrides,
  };
}

const PENALTY = 'Cancellation Penalty of 2060.00 may be added to account.';
const PREVIEW_OK: CancelRun = cancelRun({
  outcome: 'preview_ok',
  statusBefore: 'Reserved',
  statusAfter: 'Reserved',
  reasons: ['Test Reservations', 'Duplicate Booking'],
  penaltyText: PENALTY,
  screenshots: ['found.png', 'cancel-dialog.png'],
  runId: RUN_ID,
  previewDigest: DIGEST,
});

describe('AmendLookupPanel', () => {
  it('shows what the guest asked, each labelled from the email, with the footer note', () => {
    const findStay = vi.fn(NEVER_SETTLES);
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    expect(screen.getByText('Change to an existing booking')).toBeTruthy();
    expect(screen.getByText('What the guest asked')).toBeTruthy();
    expect(screen.getByText('Extend the stay by two nights')).toBeTruthy();
    expect(screen.getByText(CONFIRMATION)).toBeTruthy();
    expect(screen.getByText('Mokoena')).toBeTruthy();
    expect(screen.getByText('12 Oct 2026')).toBeTruthy();
    expect(screen.getByText('14 Oct 2026')).toBeTruthy();
    expect(screen.getAllByText('From the email')).toHaveLength(5);
    expect(screen.getByText('Luna only looks the booking up. Make the change in HMS yourself.')).toBeTruthy();
  });

  it('labels a cancellation request as one', () => {
    const findStay = vi.fn(NEVER_SETTLES);
    render(
      <AmendLookupPanel
        session={sessionWith({ ...AMEND, kind: 'cancel', requestedChange: null })}
        trpc={lookupTrpc(findStay)}
      />,
    );
    expect(screen.getByText('Cancellation request')).toBeTruthy();
    expect(screen.getByText('Not stated')).toBeTruthy();
  });

  it('renders nothing when the analysis carries no amendment', () => {
    const { container } = render(<AmendLookupPanel session={sessionWith(null)} trpc={lookupTrpc(vi.fn())} />);
    expect(container.innerHTML).toBe('');
  });

  it('never looks up HMS on its own: staff press the find button, and the wait is said up front', async () => {
    const findStay = vi.fn(NEVER_SETTLES);
    const session = sessionWith(AMEND);
    const { rerender } = render(<AmendLookupPanel session={session} trpc={lookupTrpc(findStay)} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(findStay).not.toHaveBeenCalled();
    expect(screen.getByText('Takes about 1–2 minutes. Quotes wait while it runs.')).toBeTruthy();
    pressFind();
    await waitFor(() => expect(findStay).toHaveBeenCalledTimes(1));
    expect(findStay).toHaveBeenCalledWith({ confirmation: CONFIRMATION, arrival: '2026-10-12' });
    expect(screen.getByText('Luna is looking up the booking in HMS… (about 1–2 minutes)')).toBeTruthy();
    rerender(<AmendLookupPanel session={session} trpc={lookupTrpc(findStay)} />);
    expect(findStay).toHaveBeenCalledTimes(1);
  });

  it('shows the booking HMS returns and highlights the field that differs', async () => {
    const findStay = vi.fn().mockResolvedValue(found({ departure: '2026-10-13' }));
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await waitFor(() => expect(screen.getByText('Guest wants: 14 Oct 2026')).toBeTruthy());
    expect(screen.getByText(`confirmation number ${CONFIRMATION}`)).toBeTruthy();
    expect(screen.getAllByText(/^Guest wants:/)).toHaveLength(1);
    expect(document.querySelector('[data-field="departure"]')?.getAttribute('data-differs')).toBe('true');
    expect(document.querySelector('[data-field="arrival"]')?.getAttribute('data-differs')).toBe('false');
    expect(document.querySelector('[data-field="guest"]')?.getAttribute('data-differs')).toBe('false');
  });

  it('shows rate plan, meal plan and grand total when HMS shows them', async () => {
    const findStay = vi.fn().mockResolvedValue(found());
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await waitFor(() => expect(screen.getByText('Matched on')).toBeTruthy());
    expect(screen.getByText('Rate plan')).toBeTruthy();
    expect(screen.getByText('BAR')).toBeTruthy();
    expect(screen.getByText('Meal plan')).toBeTruthy();
    expect(screen.getByText('Bed & breakfast')).toBeTruthy();
    expect(screen.getByText('Grand total')).toBeTruthy();
    expect(screen.getByText('R1 360,00')).toBeTruthy();
  });

  it('hides rate plan, meal plan and grand total when HMS does not show them', async () => {
    const findStay = vi.fn().mockResolvedValue(found({ ratePlan: null, mealPlan: null, grandTotal: null }));
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await waitFor(() => expect(screen.getByText('Matched on')).toBeTruthy());
    expect(screen.queryByText('Rate plan')).toBeNull();
    expect(screen.queryByText('Meal plan')).toBeNull();
    expect(screen.queryByText('Grand total')).toBeNull();
  });

  it('shows the booking record screenshot as a thumbnail that opens full size', async () => {
    const findStay = vi.fn().mockResolvedValue(found());
    const shot = vi.fn().mockResolvedValue({ status: 'ok', dataUrl: SHOT_PNG });
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay, shot)} />);
    pressFind();
    fireEvent.click(await screen.findByRole('button', { name: 'See the booking in HMS' }));
    expect(shot).toHaveBeenCalledWith({ runId: RUN_ID, name: 'record.png' });
    const dialog = screen.getByRole('dialog', { name: 'See the booking in HMS' });
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe(SHOT_PNG);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('explains a booking number HMS does not know, with the next step', async () => {
    const findStay = vi.fn().mockResolvedValue(NOT_FOUND);
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await waitFor(() =>
      expect(
        screen.getByText(
          'No booking with that number in HMS. Check the number in the email or search HMS by guest name.',
        ),
      ).toBeTruthy(),
    );
  });

  it('says HMS matched more than one booking', async () => {
    const findStay = vi.fn().mockResolvedValue(AMBIGUOUS);
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await waitFor(() =>
      expect(screen.getByText('HMS matched more than one booking for that number. Check HMS directly.')).toBeTruthy(),
    );
  });

  it('does not look up a booking number HMS cannot take', () => {
    const findStay = vi.fn();
    render(
      <AmendLookupPanel
        session={sessionWith({ ...AMEND, confirmationNumber: 'CEN-88412' })}
        trpc={lookupTrpc(findStay)}
      />,
    );
    expect(findStay).not.toHaveBeenCalled();
    expect(screen.getByText(AMEND_FIND_COPY.notExact)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Find this booking in HMS' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables the manual lookup and says why when the email has no booking number', () => {
    const findStay = vi.fn();
    render(<AmendLookupPanel session={sessionWith({ ...AMEND, confirmationNumber: null })} trpc={lookupTrpc(findStay)} />);
    const button = screen.getByRole('button', { name: 'Find this booking in HMS' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      screen.getByText("Luna couldn't find a booking number in the email. Search HMS by name instead."),
    ).toBeTruthy();
    expect(findStay).not.toHaveBeenCalled();
  });

  it.each([
    ['refused_lock_busy', 'HMS is busy with another quote or lookup. Try again in a minute.'],
    ['refused_lock_unavailable', "Luna can't reach HMS right now. Tell the Nava team."],
    ['refused_flag_off', 'The HMS lookup is not connected in this session. Search HMS by hand.'],
    ['refused_input_invalid', AMEND_FIND_COPY.notExact],
    ['execution_failure', 'Luna could not read the HMS result. Try again in a minute.'],
  ])('shows the copy for a %s result', async (outcome, message) => {
    const findStay = vi.fn().mockResolvedValue(refusal(outcome));
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
  });

  it('reports a failed find call as a read failure', async () => {
    const findStay = vi.fn().mockRejectedValue(new Error('socket hang up'));
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await waitFor(() =>
      expect(screen.getByText('Luna could not read the HMS result. Try again in a minute.')).toBeTruthy(),
    );
  });

  it('runs the find again when staff press the button after a failed result', async () => {
    const findStay = vi
      .fn()
      .mockResolvedValueOnce(refusal('execution_failure'))
      .mockResolvedValueOnce(found());
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await screen.findByText('Luna could not read the HMS result. Try again in a minute.');
    fireEvent.click(screen.getByRole('button', { name: 'Find this booking in HMS' }));
    await waitFor(() => expect(screen.getByText('Matched on')).toBeTruthy());
    expect(findStay).toHaveBeenCalledTimes(2);
  });
});

const CANCEL_ARRIVAL = CANCEL.arrival ?? '';

type CancelMocks = {
  preview?: ReturnType<typeof vi.fn>;
  commit?: ReturnType<typeof vi.fn>;
  shot?: ReturnType<typeof vi.fn>;
};

/** Renders a cancel email whose booking HMS finds, with the paneStayCancel routes mocked. */
function renderCancel(mocks: CancelMocks) {
  const findStay = vi.fn().mockResolvedValue(found({ arrival: CANCEL_ARRIVAL, departure: CANCEL.departure ?? '' }, []));
  const preview = mocks.preview ?? vi.fn();
  const commit = mocks.commit ?? vi.fn();
  const shot = mocks.shot ?? vi.fn().mockResolvedValue(NO_SHOT);
  const trpc = {
    ...lookupTrpc(findStay),
    paneStayCancel: {
      previewCancel: { mutate: preview },
      commitCancel: { mutate: commit },
      paneStayScreenshot: { query: shot },
    },
  };
  render(<AmendLookupPanel session={sessionWith(CANCEL)} trpc={trpc} />);
  pressFind();
  return { preview, commit, shot, findStay };
}

describe('AmendLookupPanel cancel from the pane', () => {
  it('says cancelling is switched off and gives the HMS steps when the pane save flag is off', async () => {
    const { preview } = renderCancel({});
    await waitFor(() =>
      expect(
        screen.getByText(
          'Cancelling from here is switched off for now. Cancel it in HMS: open 57291630-1, Actions → Cancel Reservation.',
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'Preview cancellation' })).toBeNull();
    expect(preview).not.toHaveBeenCalled();
  });

  it('previews the cancel, shows the HMS fee, then cancels with the chosen reason and the preview digest', async () => {
    capabilities.paneSave = true;
    const shot = vi.fn().mockResolvedValue({ status: 'ok', dataUrl: SHOT_PNG });
    const preview = vi.fn().mockResolvedValue(PREVIEW_OK);
    const commit = vi.fn().mockResolvedValue(
      cancelRun({ outcome: 'cancelled', statusBefore: 'Reserved', statusAfter: 'Cancelled', screenshots: ['readback.png'], runId: RUN_ID }),
    );
    renderCancel({ preview, commit, shot });

    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    expect(await screen.findByText(`HMS says: ${PENALTY}`)).toBeTruthy();
    expect(preview).toHaveBeenCalledWith({ confirmation: CONFIRMATION, arrival: CANCEL_ARRIVAL });
    expect(screen.getByText('Status in HMS: Reserved')).toBeTruthy();

    const commitButton = screen.getByRole('button', { name: 'Cancel booking in HMS' }) as HTMLButtonElement;
    expect(commitButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Cancellation reason'), { target: { value: 'Duplicate Booking' } });
    expect(commitButton.disabled).toBe(false);
    expect(
      screen.getByText(
        `Luna will cancel 57291630-1 for Thabo Mokoena. HMS says: ${PENALTY} This can't be undone from here.`,
      ),
    ).toBeTruthy();

    fireEvent.click(commitButton);
    expect(await screen.findByText('Cancelled in HMS – status now Cancelled')).toBeTruthy();
    expect(commit).toHaveBeenCalledWith({
      confirmation: CONFIRMATION,
      arrival: CANCEL_ARRIVAL,
      reason: 'Duplicate Booking',
      previewDigest: DIGEST,
    });
    await waitFor(() => expect(shot).toHaveBeenLastCalledWith({ runId: RUN_ID, name: 'readback.png' }));
    fireEvent.click(await screen.findByRole('button', { name: 'See what Luna saw in HMS' }));
    const dialog = screen.getByRole('dialog', { name: 'See what Luna saw in HMS' });
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe(SHOT_PNG);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says so when HMS shows no cancellation fee', async () => {
    capabilities.paneSave = true;
    const preview = vi.fn().mockResolvedValue({ ...PREVIEW_OK, penaltyText: null });
    renderCancel({ preview });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    fireEvent.change(await screen.findByLabelText('Cancellation reason'), {
      target: { value: 'Duplicate Booking' },
    });
    expect(screen.getByText('HMS showed no cancellation fee.')).toBeTruthy();
    expect(
      screen.getByText(
        "Luna will cancel 57291630-1 for Thabo Mokoena. HMS showed no cancellation fee. This can't be undone from here.",
      ),
    ).toBeTruthy();
  });

  it('says HMS may have cancelled the booking when the commit comes back cancel_unconfirmed', async () => {
    capabilities.paneSave = true;
    const preview = vi.fn().mockResolvedValue(PREVIEW_OK);
    const commit = vi.fn().mockResolvedValue(cancelRun({ outcome: 'cancel_unconfirmed' }));
    renderCancel({ preview, commit });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    fireEvent.change(await screen.findByLabelText('Cancellation reason'), {
      target: { value: 'Duplicate Booking' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking in HMS' }));
    expect(
      await screen.findByText('HMS may have cancelled this booking. Check HMS before trying again.'),
    ).toBeTruthy();
  });

  it('says the booking is already cancelled in HMS and offers no cancel', async () => {
    capabilities.paneSave = true;
    const preview = vi.fn().mockResolvedValue(
      cancelRun({ outcome: 'already_cancelled', statusBefore: 'Cancelled', statusAfter: 'Cancelled' }),
    );
    renderCancel({ preview });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    expect(await screen.findByText('This booking is already cancelled in HMS.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel booking in HMS' })).toBeNull();
  });

  it.each([
    ['refused_not_lab', 'Cancelling from here only works on test bookings right now.'],
    ['refused_lock_busy', 'HMS is busy with another quote or lookup. Try again in a minute.'],
    ['refused_lock_unavailable', "Luna can't reach HMS right now. Tell the Nava team."],
    ['execution_failure', "Luna couldn't finish in HMS. Check HMS yourself."],
    [
      'refused_flag_off',
      'Cancelling from here is switched off for now. Cancel it in HMS: open 57291630-1, Actions → Cancel Reservation.',
    ],
  ])('explains the %s preview result and keeps the preview button', async (outcome, message) => {
    capabilities.paneSave = true;
    const preview = vi.fn().mockResolvedValue(cancelRun({ outcome }));
    renderCancel({ preview });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Preview cancellation' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel booking in HMS' })).toBeNull();
  });

  it.each(['cancel_preview_required', 'cancel_digest_mismatch'])(
    'asks for a fresh preview when the commit comes back %s',
    async (outcome) => {
      capabilities.paneSave = true;
      const preview = vi.fn().mockResolvedValue(PREVIEW_OK);
      const commit = vi.fn().mockResolvedValue(cancelRun({ outcome }));
      renderCancel({ preview, commit });
      fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
      fireEvent.change(await screen.findByLabelText('Cancellation reason'), {
        target: { value: 'Duplicate Booking' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel booking in HMS' }));
      expect(await screen.findByText('Preview the cancellation again first.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Preview cancellation' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Cancel booking in HMS' })).toBeNull();
    },
  );

  it('asks for another reason when HMS does not accept the chosen one', async () => {
    capabilities.paneSave = true;
    const preview = vi.fn().mockResolvedValue(PREVIEW_OK);
    const commit = vi.fn().mockResolvedValue(cancelRun({ outcome: 'refused_reason_missing' }));
    renderCancel({ preview, commit });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    fireEvent.change(await screen.findByLabelText('Cancellation reason'), {
      target: { value: 'Duplicate Booking' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking in HMS' }));
    expect(await screen.findByText('HMS did not accept that reason. Pick another and try again.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Cancel booking in HMS' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Cancellation reason') as HTMLSelectElement).selectedIndex).toBe(0);
  });

  it('reports a failed preview call and leaves the preview button in place', async () => {
    capabilities.paneSave = true;
    const preview = vi.fn().mockRejectedValue(new Error('socket hang up'));
    renderCancel({ preview });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    expect(await screen.findByText("Luna couldn't finish in HMS. Check HMS yourself.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Preview cancellation' })).toBeTruthy();
  });

  it('says Luna can preview, not only look up, when cancel mail can be previewed', async () => {
    capabilities.paneSave = true;
    renderCancel({});
    await screen.findByRole('button', { name: 'Preview cancellation' });
    expect(
      screen.getByText(
        'Luna can preview the cancellation for you. Nothing is cancelled until you press Cancel booking in HMS.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Luna only looks the booking up. Make the change in HMS yourself.')).toBeNull();
  });

  it('keeps the look-up footer on cancel mail when the pane save flag is off', async () => {
    renderCancel({});
    await screen.findByText(
      'Cancelling from here is switched off for now. Cancel it in HMS: open 57291630-1, Actions → Cancel Reservation.',
    );
    expect(screen.getByText('Luna only looks the booking up. Make the change in HMS yourself.')).toBeTruthy();
  });

  it('keeps the look-up footer on amend mail even when the pane save flag is on', () => {
    capabilities.paneSave = true;
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(vi.fn(NEVER_SETTLES))} />);
    expect(screen.getByText('Luna only looks the booking up. Make the change in HMS yourself.')).toBeTruthy();
    expect(screen.queryByText(/Luna can preview the cancellation/)).toBeNull();
  });
});

describe('amend find helpers', () => {
  it('binds no client when the paneStayLookup routes are missing', () => {
    expect(amendFindClientFromTrpc({ workstation: {} })).toBeNull();
  });

  it('binds findStay and screenshot to the paneStayLookup routes', async () => {
    const findStay = vi.fn().mockResolvedValue(NOT_FOUND);
    const shot = vi.fn().mockResolvedValue(NO_SHOT);
    const client = amendFindClientFromTrpc(lookupTrpc(findStay, shot));
    expect(client).not.toBeNull();
    await client?.findStay({ confirmation: CONFIRMATION });
    await client?.screenshot({ runId: RUN_ID, name: 'record.png' });
    expect(findStay).toHaveBeenCalledWith({ confirmation: CONFIRMATION });
    expect(shot).toHaveBeenCalledWith({ runId: RUN_ID, name: 'record.png' });
  });

  it('sends the confirmation number alone when the email gives no arrival', async () => {
    const findStay = vi.fn().mockResolvedValue(NOT_FOUND);
    const client: AmendFindClient = { findStay, screenshot: vi.fn() };
    await runHmsFind({ client, confirmation: CONFIRMATION });
    expect(findStay).toHaveBeenCalledWith({ confirmation: CONFIRMATION });
  });

  it('sends the email arrival with the confirmation only when it is a real ISO day', async () => {
    const findStay = vi.fn().mockResolvedValue(NOT_FOUND);
    const client: AmendFindClient = { findStay, screenshot: vi.fn() };
    await runHmsFind({ client, confirmation: CONFIRMATION, arrival: '2026-10-12' });
    expect(findStay).toHaveBeenLastCalledWith({ confirmation: CONFIRMATION, arrival: '2026-10-12' });
    await runHmsFind({ client, confirmation: CONFIRMATION, arrival: '2026-02-31' });
    expect(findStay).toHaveBeenLastCalledWith({ confirmation: CONFIRMATION });
  });

  it('says HMS shows another arrival when it refuses the record on arrival_mismatch', async () => {
    const mismatch: FindStayReply = {
      outcome: 'ambiguous',
      reason: 'arrival_mismatch',
      stay: null,
      screenshots: [],
      runId: null,
    };
    const client: AmendFindClient = { findStay: vi.fn().mockResolvedValue(mismatch), screenshot: vi.fn() };
    const run = await runHmsFind({ client, confirmation: CONFIRMATION, arrival: '2026-10-12' });
    expect(run).toEqual({ kind: 'error', message: AMEND_FIND_COPY.arrivalDiffers });
  });

  it('reports unavailable when no client is bound', async () => {
    await expect(runHmsFind({ client: null, confirmation: CONFIRMATION })).resolves.toEqual({
      kind: 'error',
      message: AMEND_FIND_COPY.unavailable,
    });
  });

  it('names only the fields where the email and HMS disagree', () => {
    expect(amendDiffs(AMEND, stayRecord({ departure: '2026-10-13' }))).toEqual({ departure: '14 Oct 2026' });
    expect(amendDiffs(AMEND, stayRecord({ departure: '2026-10-14' }))).toEqual({});
    expect(
      amendDiffs(AMEND, stayRecord({ lastName: 'Smith', arrival: '2026-10-12', departure: '2026-10-14' })),
    ).toEqual({ guest: 'Mokoena' });
  });

  it('keeps the amendment on the session where the badge can read it', () => {
    expect(amendmentOf(sessionWith(CANCEL))?.kind).toBe('cancel');
    expect(amendmentOf(sessionWith(null))).toBeNull();
  });
});
