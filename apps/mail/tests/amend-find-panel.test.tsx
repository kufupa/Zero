/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmendLookupPanel } from '../components/quote-workflow/amend-lookup-panel';
import {
  AMEND_FIND_COPY,
  amendFindClientFromTrpc,
  pollHmsFindReceipt,
  type HmsFindMatchWire,
  type HmsFindReceiptWire,
} from '../lib/quote-workflow/amend-find';
import type { CancelRun } from '../lib/quote-workflow/amend-cancel';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import type { QuoteAmendment, QuoteSession } from '../lib/quote-workflow/types';

// The panel reads brain.getCapabilities through a query client. Tests set paneSave directly.
const capabilities = vi.hoisted(() => ({ paneSave: false }));
vi.mock('@/hooks/use-pilot-capabilities', () => ({
  usePilotCapabilities: () => capabilities,
}));

afterEach(() => {
  cleanup();
  capabilities.paneSave = false;
});

const THREAD = 'thread-7';
const POLL_FAST = { intervalMs: 1, timeoutMs: 10_000 };

const AMEND: QuoteAmendment = {
  kind: 'amend',
  confirmationNumber: 'CEN-88412',
  guestLastName: 'Mokoena',
  arrival: '2026-10-12',
  departure: '2026-10-14',
  requestedChange: 'Extend the stay by two nights',
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

function trpcMock(enqueue: ReturnType<typeof vi.fn>, read: ReturnType<typeof vi.fn>) {
  return {
    ai: {
      enqueueHmsRead: { mutate: enqueue },
      readHmsReceipt: { query: read },
    },
  };
}

function fact<T>(value: T | null) {
  return value === null ? { state: 'unknown', value: null } : { state: 'known', value };
}

function hmsMatch(overrides: { arrival?: string; departure?: string; label?: string } = {}): HmsFindMatchWire {
  return {
    reservationRef: 'res-1',
    label: fact(overrides.label ?? 'Thabo Mokoena'),
    referenceKind: fact('confirmation' as const),
    status: fact('Reserved'),
    arrival: fact(overrides.arrival ?? '2026-10-12'),
    departure: fact(overrides.departure ?? '2026-10-13'),
    roomType: fact('DLXKNG'),
  };
}

function foundReceipt(match: HmsFindMatchWire = hmsMatch()): HmsFindReceiptWire {
  return {
    readResultRef: 'hms-read-1',
    result: { status: 'ok', issues: [], data: { matches: [match], matchCount: 1 } },
  };
}

const NOT_FOUND_RECEIPT: HmsFindReceiptWire = {
  readResultRef: 'hms-read-1',
  result: { status: 'not_found', issues: [], data: null },
};

const RECEIPT_PENDING = new Error('READ_RECEIPT_NOT_FOUND');
const NEVER_SETTLES = () => new Promise<never>(() => {});

describe('AmendLookupPanel', () => {
  it('shows what the guest asked, each labelled from the email, with the footer note', () => {
    const enqueue = vi.fn(NEVER_SETTLES);
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={trpcMock(enqueue, vi.fn())} timing={POLL_FAST} />);
    expect(screen.getByText('Change to an existing booking')).toBeTruthy();
    expect(screen.getByText('What the guest asked')).toBeTruthy();
    expect(screen.getByText('Extend the stay by two nights')).toBeTruthy();
    expect(screen.getByText('CEN-88412')).toBeTruthy();
    expect(screen.getByText('Mokoena')).toBeTruthy();
    expect(screen.getByText('12 Oct 2026')).toBeTruthy();
    expect(screen.getByText('14 Oct 2026')).toBeTruthy();
    expect(screen.getAllByText('From the email')).toHaveLength(5);
    expect(screen.getByText('Luna only looks the booking up. Make the change in HMS yourself.')).toBeTruthy();
  });

  it('labels a cancellation request as one', () => {
    const enqueue = vi.fn(NEVER_SETTLES);
    render(
      <AmendLookupPanel
        session={sessionWith({ ...AMEND, kind: 'cancel', requestedChange: null })}
        trpc={trpcMock(enqueue, vi.fn())}
        timing={POLL_FAST}
      />,
    );
    expect(screen.getByText('Cancellation request')).toBeTruthy();
    expect(screen.getByText('Not stated')).toBeTruthy();
  });

  it('renders nothing when the analysis carries no amendment', () => {
    const { container } = render(
      <AmendLookupPanel session={sessionWith(null)} trpc={trpcMock(vi.fn(), vi.fn())} timing={POLL_FAST} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('auto-runs the find once per email with the thread id', async () => {
    const enqueue = vi.fn().mockResolvedValue({ readResultRef: 'hms-read-1' });
    const read = vi.fn().mockRejectedValue(RECEIPT_PENDING);
    const session = sessionWith(AMEND);
    const { rerender } = render(
      <AmendLookupPanel session={session} trpc={trpcMock(enqueue, read)} timing={POLL_FAST} />,
    );
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(0));
    expect(screen.getByText(AMEND_FIND_COPY.looking)).toBeTruthy();
    rerender(<AmendLookupPanel session={session} trpc={trpcMock(enqueue, read)} timing={POLL_FAST} />);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({ threadId: THREAD, toolId: 'hms_find_reservation' });
  });

  it('stops polling once a receipt arrives', async () => {
    const enqueue = vi.fn().mockResolvedValue({ readResultRef: 'hms-read-1' });
    const read = vi.fn().mockRejectedValueOnce(RECEIPT_PENDING).mockResolvedValue(foundReceipt());
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={trpcMock(enqueue, read)} timing={POLL_FAST} />);
    await waitFor(() => expect(screen.getByText('13 Oct 2026')).toBeTruthy());
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith({ threadId: THREAD, readResultRef: 'hms-read-1' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('highlights the field that differs and says what the guest wants', async () => {
    const enqueue = vi.fn().mockResolvedValue({ readResultRef: 'hms-read-1' });
    const read = vi.fn().mockResolvedValue(foundReceipt());
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={trpcMock(enqueue, read)} timing={POLL_FAST} />);
    await waitFor(() => expect(screen.getByText('Guest wants: 14 Oct 2026')).toBeTruthy());
    expect(screen.getAllByText(/^Guest wants:/)).toHaveLength(1);
    expect(document.querySelector('[data-field="departure"]')?.getAttribute('data-differs')).toBe('true');
    expect(document.querySelector('[data-field="arrival"]')?.getAttribute('data-differs')).toBe('false');
    expect(document.querySelector('[data-field="guest"]')?.getAttribute('data-differs')).toBe('false');
  });

  it('explains a booking number HMS does not know, with the next step', async () => {
    const enqueue = vi.fn().mockResolvedValue({ readResultRef: 'hms-read-1' });
    const read = vi.fn().mockResolvedValue(NOT_FOUND_RECEIPT);
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={trpcMock(enqueue, read)} timing={POLL_FAST} />);
    await waitFor(() =>
      expect(
        screen.getByText(
          'No booking with that number in HMS. Check the number in the email or search HMS by guest name.',
        ),
      ).toBeTruthy(),
    );
  });

  it('disables the manual lookup and says why when the email has no booking number', () => {
    const enqueue = vi.fn();
    render(
      <AmendLookupPanel
        session={sessionWith({ ...AMEND, confirmationNumber: null })}
        trpc={trpcMock(enqueue, vi.fn())}
        timing={POLL_FAST}
      />,
    );
    const button = screen.getByRole('button', { name: 'Find this booking in HMS' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      screen.getByText("Luna couldn't find a booking number in the email. Search HMS by name instead."),
    ).toBeTruthy();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('reports HMS busy when no receipt arrives inside the poll window', async () => {
    const enqueue = vi.fn().mockResolvedValue({ readResultRef: 'hms-read-1' });
    const read = vi.fn().mockRejectedValue(RECEIPT_PENDING);
    render(
      <AmendLookupPanel
        session={sessionWith(AMEND)}
        trpc={trpcMock(enqueue, read)}
        timing={{ intervalMs: 1, timeoutMs: 5 }}
      />,
    );
    await waitFor(() => expect(screen.getByText('HMS is busy. Try again in a minute.')).toBeTruthy());
  });

  it('maps a released-HMS enqueue failure to busy without polling', async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error('HMS_READ_RELEASE_UNAVAILABLE'));
    const read = vi.fn();
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={trpcMock(enqueue, read)} timing={POLL_FAST} />);
    await waitFor(() => expect(screen.getByText('HMS is busy. Try again in a minute.')).toBeTruthy());
    expect(read).not.toHaveBeenCalled();
  });
});

describe('amend find helpers', () => {
  it('polls every 2s and gives up at 90s', async () => {
    let clock = 0;
    const read = vi.fn().mockRejectedValue(RECEIPT_PENDING);
    const outcome = await pollHmsFindReceipt({
      readHmsReceipt: read,
      threadId: THREAD,
      readResultRef: 'hms-read-1',
      isCurrent: () => true,
      wait: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(outcome).toEqual({ kind: 'timeout' });
    expect(read).toHaveBeenCalledTimes(45);
    expect(clock).toBe(90_000);
  });

  it('binds no client when the ai routes are missing', () => {
    expect(amendFindClientFromTrpc({ workstation: {} })).toBeNull();
  });
});

const CANCEL_CONFIRMATION = '57291630-1';
const CANCEL_ARRIVAL = '2027-09-14';
const CANCEL_DEPARTURE = '2027-09-16';
const CANCEL: QuoteAmendment = {
  ...AMEND,
  kind: 'cancel',
  confirmationNumber: CANCEL_CONFIRMATION,
  arrival: CANCEL_ARRIVAL,
  departure: CANCEL_DEPARTURE,
  requestedChange: null,
};
const RUN_ID = '3f2c9a1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
const PENALTY = 'Cancellation Penalty of 2060.00 may be added to account.';
const PREVIEW_OK: CancelRun = {
  outcome: 'preview_ok',
  statusBefore: 'Reserved',
  statusAfter: 'Reserved',
  reasons: ['Test Reservations', 'Duplicate Booking'],
  penaltyText: PENALTY,
  screenshots: ['found.png', 'cancel-dialog.png'],
  runId: RUN_ID,
};
const SHOT_PNG = 'data:image/png;base64,iVBORw0KGgo=';
const NO_SHOT = { status: 'unavailable', reason: 'screenshot_unavailable' };

type CancelMocks = {
  preview?: ReturnType<typeof vi.fn>;
  commit?: ReturnType<typeof vi.fn>;
  shot?: ReturnType<typeof vi.fn>;
};

/** Renders a cancel email whose booking HMS finds, with the paneStayCancel routes mocked. */
function renderCancel(mocks: CancelMocks) {
  const enqueue = vi.fn().mockResolvedValue({ readResultRef: 'hms-read-1' });
  const read = vi
    .fn()
    .mockResolvedValue(foundReceipt(hmsMatch({ arrival: CANCEL_ARRIVAL, departure: CANCEL_DEPARTURE })));
  const preview = mocks.preview ?? vi.fn();
  const commit = mocks.commit ?? vi.fn();
  const shot = mocks.shot ?? vi.fn().mockResolvedValue(NO_SHOT);
  const trpc = {
    ...trpcMock(enqueue, read),
    paneStayCancel: {
      previewCancel: { mutate: preview },
      commitCancel: { mutate: commit },
      paneStayScreenshot: { query: shot },
    },
  };
  render(<AmendLookupPanel session={sessionWith(CANCEL)} trpc={trpc} timing={POLL_FAST} />);
  return { preview, commit, shot };
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

  it('previews the cancel, shows the HMS fee, then cancels with the chosen reason', async () => {
    capabilities.paneSave = true;
    const shot = vi.fn().mockResolvedValue({ status: 'ok', dataUrl: SHOT_PNG });
    const preview = vi.fn().mockResolvedValue(PREVIEW_OK);
    const commit = vi.fn().mockResolvedValue({
      ...PREVIEW_OK,
      outcome: 'cancelled',
      statusAfter: 'Cancelled',
      screenshots: ['readback.png'],
    });
    renderCancel({ preview, commit, shot });

    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    expect(await screen.findByText(`HMS says: ${PENALTY}`)).toBeTruthy();
    expect(preview).toHaveBeenCalledWith({ confirmation: CANCEL_CONFIRMATION, arrival: CANCEL_ARRIVAL });
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
      confirmation: CANCEL_CONFIRMATION,
      arrival: CANCEL_ARRIVAL,
      reason: 'Duplicate Booking',
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

  it('says the booking is already cancelled in HMS and offers no cancel', async () => {
    capabilities.paneSave = true;
    const preview = vi.fn().mockResolvedValue({
      ...PREVIEW_OK,
      outcome: 'already_cancelled',
      statusBefore: 'Cancelled',
      statusAfter: 'Cancelled',
      reasons: [],
      penaltyText: null,
      screenshots: [],
    });
    renderCancel({ preview });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    expect(await screen.findByText('This booking is already cancelled in HMS.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel booking in HMS' })).toBeNull();
  });

  it.each([
    ['refused_not_lab', 'Cancelling from here only works on test bookings right now.'],
    ['refused_lock_unavailable', 'HMS is busy. Try again in a minute.'],
    ['execution_failure', "Luna couldn't finish in HMS. Check HMS yourself."],
    [
      'refused_flag_off',
      'Cancelling from here is switched off for now. Cancel it in HMS: open 57291630-1, Actions → Cancel Reservation.',
    ],
  ])('explains the %s preview result and keeps the preview button', async (outcome, message) => {
    capabilities.paneSave = true;
    const preview = vi.fn().mockResolvedValue({
      outcome,
      statusBefore: null,
      statusAfter: null,
      reasons: [],
      penaltyText: null,
      screenshots: [],
    });
    renderCancel({ preview });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Preview cancellation' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel booking in HMS' })).toBeNull();
  });

  it('asks for another reason when HMS does not accept the chosen one', async () => {
    capabilities.paneSave = true;
    const preview = vi.fn().mockResolvedValue(PREVIEW_OK);
    const commit = vi.fn().mockResolvedValue({ ...PREVIEW_OK, outcome: 'refused_reason_missing' });
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
});
