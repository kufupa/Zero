/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmendLookupPanel } from '../components/quote-workflow/amend-lookup-panel';
import {
  AMEND_FIND_COPY,
  amendFindClientFromTrpc,
  pollHmsFindReceipt,
  type HmsFindMatchWire,
  type HmsFindReceiptWire,
} from '../lib/quote-workflow/amend-find';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import type { QuoteAmendment, QuoteSession } from '../lib/quote-workflow/types';

afterEach(() => cleanup());

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
