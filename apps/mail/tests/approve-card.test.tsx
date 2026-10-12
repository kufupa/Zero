/**
 * @vitest-environment happy-dom
 */
import {
  HMS_WRITE_IDLE_POLL_MS,
  HMS_WRITE_POLL_MS,
  hmsApprovalFromTrpc,
  refusalCopy,
  writeRowsOf,
  writeStatusOf,
  type HmsApprovalClient,
  type HmsApproved,
  type HmsReviewed,
  type HmsWriteView,
} from '../lib/quote-workflow/hms-write';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApproveCard } from '../components/quote-workflow/approve-card';
import { BookingVoucherCard } from '../components/nava-pane/blocks/booking-voucher-card';
import { initialQuoteSession } from '../lib/quote-workflow/session';
import type { QuoteAmendment, QuoteAnalysis, QuoteSession } from '../lib/quote-workflow/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unmaskedPii } from './helpers/pii-marks';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The pane block binds its write card off the shared tRPC client. Only the hmsApproval routes answer here.
const paneWrite = vi.hoisted(() => ({ view: null as unknown }));
vi.mock('@/providers/query-provider', () => ({
  trpcClient: {
    hmsApproval: {
      writeState: {
        query: async () => {
          if (paneWrite.view instanceof Error) throw paneWrite.view;
          return paneWrite.view;
        },
      },
      approve: { mutate: async () => ({}) },
      review: { mutate: async () => ({}) },
      resolveNeedsCheck: { mutate: async () => ({}) },
      reread: { mutate: async () => ({ status: 'stored' }) },
      evidence: { query: async () => ({ status: 'unavailable', reason: 'evidence_unavailable' }) },
    },
  },
}));

const WORK_ITEM = '3f8a2c1e-9b7d-4e6f-8a1b-2c3d4e5f6a7b';
const CONFIRMATION = 'LAB-40417';
const READ_AT = '2026-10-10T09:00:00.000Z';
const EVENT_ID = '7b1e2d3c-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
const DIGEST = 'd'.repeat(64);

const APPROVED: HmsApproved = {
  grantId: 'grant-1',
  runId: 'run-2',
  hmsReadAt: READ_AT,
  expiresAt: READ_AT,
};
const REVIEWED: HmsReviewed = { runId: 'run-1', status: 'done' };

type Run = NonNullable<HmsWriteView['run']>;

function viewWith(patch: Partial<HmsWriteView> = {}): HmsWriteView {
  return {
    status: 'needs_you',
    form: { arrival: '2026-11-02', board: 'bb' },
    formDigest: DIGEST,
    before: { arrival: '2026-11-01', board: 'room_only' },
    snapshot: { readAt: READ_AT, stale: false },
    grant: null,
    run: null,
    needsCheck: false,
    ...patch,
  };
}

function runWith(state: string, patch: Partial<Run> = {}): Run {
  return {
    runId: 'run-1',
    state,
    failureClass: null,
    lastError: null,
    evidence: [],
    reviewed: null,
    ...patch,
  };
}

function fakeClient(view: HmsWriteView): HmsApprovalClient {
  return {
    writeState: vi.fn(async () => view),
    approve: vi.fn(async () => APPROVED),
    review: vi.fn(async () => REVIEWED),
    resolveNeedsCheck: vi.fn(async () => ({ runId: 'run-1', resolution: 'staff_checked' })),
    reread: vi.fn(async () => ({ status: 'stored' as const, readAt: READ_AT })),
    evidence: vi.fn(async () => ({
      status: 'unavailable' as const,
      reason: 'evidence_unavailable',
    })),
  };
}

function renderCard(
  client: HmsApprovalClient,
  patch: Partial<Parameters<typeof ApproveCard>[0]> = {},
) {
  return render(
    <ApproveCard
      client={client}
      workItemId={WORK_ITEM}
      writesEnabled
      confirmation={CONFIRMATION}
      {...patch}
    />,
  );
}

afterEach(() => cleanup());

describe('ApproveCard approval', () => {
  it('lists each changed value as before to after, with one Approve button', async () => {
    renderCard(fakeClient(viewWith()));
    const list = await screen.findByRole('list', { name: 'Values to write' });
    expect(list.textContent).toContain('Arrival');
    expect(list.textContent).toContain('1 Nov 2026');
    expect(list.textContent).toContain('2 Nov 2026');
    expect(list.textContent).toContain('Room only');
    expect(list.textContent).toContain('Bed & breakfast');
    const approve = screen.getByRole('button', { name: 'Approve these values' });
    expect(approve.hasAttribute('disabled')).toBe(false);
    expect(screen.getAllByRole('button', { name: /approve/i })).toHaveLength(1);
  });

  it('shows the re-approve state when an edit changed the form after approval', async () => {
    const client = fakeClient(
      viewWith({ grant: { grantId: 'grant-1', consumed: false, fingerprintMatches: false } }),
    );
    renderCard(client);
    expect(await screen.findByText('Changed since approval — approve again')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve again' })).toBeTruthy();
  });

  it('blocks approval on a stale HMS read, and Re-read HMS stores a fresh read then reads the state again', async () => {
    const stale = viewWith({ snapshot: { readAt: READ_AT, stale: true } });
    const client = fakeClient(stale);
    renderCard(client);
    expect(await screen.findByText(/Re-read HMS first/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Approve these values' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Re-read HMS' }));
    await waitFor(() => expect(client.reread).toHaveBeenCalledWith({ workItemId: WORK_ITEM }));
    await waitFor(() => expect(client.writeState).toHaveBeenCalledTimes(2));
  });

  it('says so when the re-read is refused, and reads nothing again', async () => {
    const client = fakeClient(viewWith({ snapshot: null }));
    vi.mocked(client.reread).mockResolvedValueOnce({ status: 'refused', reason: 'form_invalid' });
    renderCard(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Re-read HMS' }));
    expect(await screen.findByText('Nava could not read HMS again. Try again.')).toBeTruthy();
    expect(client.writeState).toHaveBeenCalledTimes(1);
  });

  it('a write still queued with values changed since approval can be approved again', async () => {
    const client = fakeClient(
      viewWith({
        grant: { grantId: 'grant-1', consumed: false, fingerprintMatches: false },
        run: runWith('queued'),
      }),
    );
    renderCard(client);
    expect(await screen.findByText(/the queued write will not run/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve again' }));
    await waitFor(() =>
      expect(client.approve).toHaveBeenCalledWith({ workItemId: WORK_ITEM, formDigest: DIGEST }),
    );
  });

  it('treats a missing HMS read the same as a stale one', async () => {
    renderCard(fakeClient(viewWith({ snapshot: null })));
    expect(await screen.findByText(/Re-read HMS first/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Approve these values' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('approves the work item with the digest of the values it shows, then reads the state again', async () => {
    const client = fakeClient(viewWith());
    renderCard(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve these values' }));
    await waitFor(() =>
      expect(client.approve).toHaveBeenCalledWith({ workItemId: WORK_ITEM, formDigest: DIGEST }),
    );
    await waitFor(() => expect(client.writeState).toHaveBeenCalledTimes(2));
  });

  it('an approval refused because the values moved on says so and reads the new values', async () => {
    const client = fakeClient(viewWith());
    vi.mocked(client.approve).mockRejectedValueOnce(new Error('form_outdated'));
    renderCard(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve these values' }));
    expect(await screen.findByText(/changed since this card loaded/)).toBeTruthy();
    await waitFor(() => expect(client.writeState).toHaveBeenCalledTimes(2));
  });

  it('says in words why a refused approval did not go through', async () => {
    const client = fakeClient(viewWith());
    vi.mocked(client.approve).mockRejectedValueOnce(new Error('write_in_flight'));
    renderCard(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve these values' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/still running/)).toBeTruthy();
  });
});

describe('ApproveCard write states', () => {
  it.each([
    ['queued', /Queued in HMS\./],
    ['claimed', /Running in HMS\./],
    ['running', /Running in HMS\./],
    ['retry_wait', /Retrying in HMS\./],
  ])('shows a run in state %s as moving, with no approve control', async (state, copy) => {
    renderCard(fakeClient(viewWith({ run: runWith(state) })));
    expect(await screen.findByText(copy)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('shows a succeeded write with its screenshots, and review and no approve', async () => {
    const client = fakeClient(
      viewWith({
        grant: { grantId: 'grant-1', consumed: true, fingerprintMatches: true },
        run: runWith('succeeded', {
          evidence: [{ eventId: EVENT_ID, name: '02-result.png', expired: false }],
        }),
      }),
    );
    renderCard(client);
    expect(await screen.findByText(/Written in HMS\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review OK' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Flag' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    await waitFor(() =>
      expect(client.evidence).toHaveBeenCalledWith({ workItemId: WORK_ITEM, eventId: EVENT_ID }),
    );
  });

  it('shows a failed-partial write with what is confirmed, and review', async () => {
    renderCard(
      fakeClient(
        viewWith({
          run: runWith('dead_letter', {
            failureClass: 'TRANSIENT_NETWORK',
            evidence: [{ eventId: EVENT_ID, name: '01-search.png', expired: false }],
          }),
        }),
      ),
    );
    expect(
      await screen.findByText(/Stopped part way\. A connection problem stopped the write\./),
    ).toBeTruthy();
    expect(screen.getByText(/Confirmed in HMS: the screenshots below/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review OK' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('shows a stop with nothing saved as not confirmed, and lets her approve again', async () => {
    renderCard(fakeClient(viewWith({ run: runWith('dead_letter', { failureClass: 'AUTH' }) })));
    expect(
      await screen.findByText(/Nava could not sign in to HMS\. Nothing was confirmed in HMS\./),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review OK' })).toBeNull();
  });

  it('puts a needs check in words and asks what she checked in HMS', async () => {
    renderCard(
      fakeClient(
        viewWith({
          needsCheck: true,
          run: runWith('dead_letter', { failureClass: 'NEEDS_CHECK', lastError: 'hms_changed' }),
        }),
      ),
    );
    expect(
      await screen.findByText('HMS changed after Nava read the booking. Nothing was written.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'I checked in HMS' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review OK' })).toBeNull();
  });

  it('blocks an empty needs-check note, then sends the trimmed note', async () => {
    const client = fakeClient(
      viewWith({
        needsCheck: true,
        run: runWith('dead_letter', { failureClass: 'LEASE_LOST', lastError: 'LEASE_LOST' }),
      }),
    );
    renderCard(client);
    fireEvent.click(await screen.findByRole('button', { name: 'I checked in HMS' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Say what you checked in HMS first.')).toBeTruthy();
    expect(client.resolveNeedsCheck).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('What did you check in HMS?'), {
      target: { value: '  Arrival is 2 Nov in HMS  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'I checked in HMS' }));
    await waitFor(() =>
      expect(client.resolveNeedsCheck).toHaveBeenCalledWith({
        workItemId: WORK_ITEM,
        note: 'Arrival is 2 Nov in HMS',
      }),
    );
  });
});

describe('ApproveCard reads', () => {
  it('keeps polling a moving write after a failed read, and offers the read again meanwhile', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const client = fakeClient(viewWith({ run: runWith('running') }));
      vi.mocked(client.writeState)
        .mockResolvedValueOnce(viewWith({ run: runWith('running') }))
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValue(viewWith({ run: runWith('succeeded') }));
      renderCard(client);
      expect(await screen.findByText(/Running in HMS/)).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HMS_WRITE_POLL_MS);
      });
      expect(await screen.findByText('Nava could not load this write.')).toBeTruthy();
      expect(screen.getByText(/Running in HMS/)).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HMS_WRITE_POLL_MS);
      });
      expect(await screen.findByText(/Written in HMS/)).toBeTruthy();
      expect(screen.queryByText('Nava could not load this write.')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BookingVoucherCard write card', () => {
  const attachForm = { action: 'attach_document', confirmation: '57291630-1', documentName: 'Voucher.pdf' };

  it('shows the approve card for an attach on mail that is not an amend or cancel', async () => {
    paneWrite.view = viewWith({ form: attachForm, before: null });
    render(
      <BookingVoucherCard
        session={initialQuoteSession()}
        internetMessageId={null}
        syncCommitted={null}
        syncPending={false}
        workItemId={WORK_ITEM}
        writesEnabled
      />,
    );
    expect(await screen.findByRole('button', { name: 'Approve these values' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy confirmation' })).toBeTruthy();
  });

  it('marks the confirmation, guest name and file name rows data-pii, and leaves the dates visible', async () => {
    paneWrite.view = viewWith({
      form: { ...attachForm, lastName: 'Guestlast', arrival: '2026-11-02' },
      before: null,
    });
    const { container } = render(
      <BookingVoucherCard
        session={initialQuoteSession()}
        internetMessageId={null}
        syncCommitted={null}
        syncPending={false}
        workItemId={WORK_ITEM}
        writesEnabled
      />,
    );
    const list = await screen.findByRole('list', { name: 'Values to write' });
    expect(unmaskedPii(list, ['57291630-1', 'Guestlast', 'Voucher.pdf'])).toEqual([]);
    const arrival = Array.from(list.querySelectorAll('li')).find((row) => row.textContent?.startsWith('Arrival'));
    expect(arrival?.querySelector('[data-pii]')).toBeNull();
    expect(container.querySelector('[data-pii]')).not.toBeNull();
  });

  it('shows no write card for an item on such mail that holds no HMS write', async () => {
    paneWrite.view = viewWith();
    const { container } = render(
      <BookingVoucherCard
        session={initialQuoteSession()}
        internetMessageId={null}
        syncCommitted={null}
        syncPending={false}
        workItemId={WORK_ITEM}
        writesEnabled
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.querySelector('section')).toBeNull();
  });

  it('shows an attach prepared while the mail is open, without a reopen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      paneWrite.view = viewWith();
      const { container } = render(
        <BookingVoucherCard
          session={initialQuoteSession()}
          internetMessageId={null}
          syncCommitted={null}
          syncPending={false}
          workItemId={WORK_ITEM}
          writesEnabled
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(container.querySelector('section')).toBeNull();
      paneWrite.view = viewWith({ form: attachForm, before: null });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HMS_WRITE_IDLE_POLL_MS);
      });
      expect(await screen.findByRole('button', { name: 'Approve these values' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not check while the page is hidden, and checks again once it is shown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    try {
      paneWrite.view = viewWith();
      const { container } = render(
        <BookingVoucherCard
          session={initialQuoteSession()}
          internetMessageId={null}
          syncCommitted={null}
          syncPending={false}
          workItemId={WORK_ITEM}
          writesEnabled
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      paneWrite.view = viewWith({ form: attachForm, before: null });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HMS_WRITE_IDLE_POLL_MS * 3);
      });
      expect(container.querySelector('section')).toBeNull();
      hidden.mockReturnValue(false);
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(HMS_WRITE_IDLE_POLL_MS);
      });
      expect(await screen.findByRole('button', { name: 'Approve these values' })).toBeTruthy();
    } finally {
      hidden.mockRestore();
      vi.useRealTimers();
    }
  });

  it('offers Try again when the first read fails, then shows the stored attach once a read lands', async () => {
    paneWrite.view = new Error('network');
    render(
      <BookingVoucherCard
        session={initialQuoteSession()}
        internetMessageId={null}
        syncCommitted={null}
        syncPending={false}
        workItemId={WORK_ITEM}
        writesEnabled
      />,
    );
    expect(await screen.findByText('Nava could not load this write.')).toBeTruthy();
    paneWrite.view = viewWith({ form: attachForm, before: null });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Approve these values' })).toBeTruthy();
  });

  describe('the HMS copy on an amendment', () => {
    const LANDING = 'https://hms.example.test/';
    afterEach(() => {
      vi.unstubAllEnvs();
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    });

    /** An amend whose mail gives the requested dates. The booked arrival is `booked`, or absent when that is null. */
    function amendSession(booked: string | null): QuoteSession {
      const amendment: QuoteAmendment = {
        kind: 'amend',
        confirmationNumber: CONFIRMATION,
        guestLastName: 'Mokoena',
        arrival: booked,
        departure: '2026-11-04',
        requestedArrival: '2026-11-02',
        requestedDeparture: '2026-11-04',
        requestedChange: 'Move the arrival to 2 Nov',
      };
      const luna = {
        groups: [
          {
            arrival: '2026-11-02',
            departure: '2026-11-04',
            rooms: 1,
            adultsPerRoom: 2,
            childAges: [],
            board: null,
            roomPreference: null,
            guestNames: [],
          },
        ],
      };
      const analysis = { intent: 'other', groups: [], secondaryAsks: [], alternatives: [], amendment, luna };
      return { ...initialQuoteSession(), analysis: analysis as unknown as QuoteAnalysis };
    }

    /** Renders the amendment Find panel and returns what its Copy for HMS handoff wrote to the clipboard. */
    async function copiedForHms(session: QuoteSession): Promise<string> {
      vi.stubEnv('VITE_PUBLIC_HMS_LANDING_URL', LANDING);
      const writeText = vi.fn(async (_text: string) => undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      paneWrite.view = viewWith();
      render(
        <BookingVoucherCard
          session={session}
          internetMessageId={null}
          syncCommitted={null}
          syncPending={false}
          workItemId={WORK_ITEM}
          writesEnabled
        />,
      );
      const panel = await screen.findByRole('region', { name: 'Change to an existing booking' });
      expect(screen.queryByRole('heading', { name: 'Booking in HMS' })).toBeNull();
      expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
      fireEvent.click(within(panel).getByRole('button', { name: 'Copy for HMS' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      return String(writeText.mock.calls[0]?.[0]);
    }

    it('leaves the arrival out when the mail does not state the booked one, never the requested date', async () => {
      expect(await copiedForHms(amendSession(null))).toBe(
        `${LANDING}\nConfirmation: ${CONFIRMATION}\nGuest surname: Mokoena`,
      );
    });

    it('copies the booked arrival the mail states', async () => {
      expect(await copiedForHms(amendSession('2026-10-30'))).toBe(
        `${LANDING}\nConfirmation: ${CONFIRMATION}\nGuest surname: Mokoena\nArrival: 2026-10-30`,
      );
    });
  });
});

describe('ApproveCard gated off', () => {
  it('shows disabled approval and reread controls and keeps the Copy confirmation handoff', async () => {
    const client = fakeClient(viewWith({ snapshot: null, run: runWith('dead_letter', { failureClass: 'AUTH' }) }));
    renderCard(client, { writesEnabled: false });
    expect(screen.getByText(/Saving to HMS from this pane is off for now/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy confirmation' })).toBeTruthy();
    const approve = (await screen.findByRole('button', { name: /approve/i })) as HTMLButtonElement;
    const reread = (await screen.findByRole('button', { name: /re.?read/i })) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(reread.disabled).toBe(true);
    expect(screen.getAllByText('Coming soon').length).toBeGreaterThanOrEqual(2);
    fireEvent.click(approve);
    fireEvent.click(reread);
    expect(client.approve).not.toHaveBeenCalled();
    expect(client.reread).not.toHaveBeenCalled();
    expect(client.writeState).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when the hmsApproval routes are not on the client', () => {
    const { container } = renderCard(fakeClient(viewWith()), { client: null });
    expect(container.textContent).toBe('');
  });
});

describe('hmsApprovalFromTrpc and refusals', () => {
  it('binds all six routes, and is null while any is missing', async () => {
    expect(hmsApprovalFromTrpc({})).toBeNull();
    expect(hmsApprovalFromTrpc({ hmsApproval: { writeState: { query: vi.fn() } } })).toBeNull();

    const approve = vi.fn(async () => APPROVED);
    const client = hmsApprovalFromTrpc({
      hmsApproval: {
        writeState: { query: vi.fn(async () => viewWith()) },
        approve: { mutate: approve },
        review: { mutate: vi.fn(async () => REVIEWED) },
        resolveNeedsCheck: { mutate: vi.fn(async () => ({})) },
        reread: { mutate: vi.fn(async () => ({ status: 'stored' as const, readAt: READ_AT })) },
        evidence: { query: vi.fn(async () => ({ status: 'unavailable' as const, reason: 'x' })) },
      },
    });
    expect(client).not.toBeNull();
    await client?.approve({ workItemId: WORK_ITEM, formDigest: DIGEST });
    expect(approve).toHaveBeenCalledWith({ workItemId: WORK_ITEM, formDigest: DIGEST });
  });

  it('turns a refusal name into words, and an unknown one into a generic line', () => {
    expect(refusalCopy(new Error('snapshot_stale'))).toMatch(/Re-read HMS first/);
    expect(refusalCopy(new Error('no_such_refusal'))).toBe('Nava could not do that. Try again.');
    expect(refusalCopy('not an error')).toBe('Nava could not do that. Try again.');
  });
});

describe('writeRowsOf and writeStatusOf', () => {
  it('leaves out unchanged values, and reads a missing snapshot as not read', () => {
    expect(writeRowsOf({ form: { adults: 2 }, before: { adults: 2 } })).toEqual([]);
    expect(writeRowsOf({ form: { arrival: '2026-11-02' }, before: null })).toEqual([
      { key: 'arrival', label: 'Arrival', before: 'Not read', after: '2 Nov 2026' },
    ]);
  });

  it('labels each stay in a multi-stay form, and joins list values', () => {
    const rows = writeRowsOf({
      form: {
        stays: { a: { arrival: '2026-11-02', childAges: [5, 7] } },
        other: { arrival: '2026-11-05' },
      },
      before: null,
    });
    expect(rows.map((row) => [row.label, row.after])).toEqual([
      ['Stay 1: Arrival', '2 Nov 2026'],
      ['Stay 1: Child ages', '5, 7'],
      ['Arrival', '5 Nov 2026'],
    ]);
  });

  it('opens approval only when nothing is moving, no check is open, and no executed write awaits review', () => {
    expect(writeStatusOf(viewWith()).approve).toBe(true);
    expect(writeStatusOf(viewWith({ run: runWith('running') })).approve).toBe(false);
    expect(writeStatusOf(viewWith({ run: runWith('queued') })).approve).toBe(false);
    const changed = { grantId: 'grant-1', consumed: false, fingerprintMatches: false };
    expect(writeStatusOf(viewWith({ grant: changed, run: runWith('queued') })).approve).toBe(true);
    expect(writeStatusOf(viewWith({ grant: changed, run: runWith('claimed') })).approve).toBe(
      false,
    );
    expect(writeStatusOf(viewWith({ run: runWith('succeeded') })).approve).toBe(false);
    // A form edited after the write was never written: review OK is refused, so approving again is open.
    expect(writeStatusOf(viewWith({ grant: changed, run: runWith('succeeded') })).approve).toBe(true);
    expect(
      writeStatusOf(viewWith({ run: runWith('succeeded', { reviewed: 'flag' }) })).approve,
    ).toBe(true);
    expect(writeStatusOf(viewWith({ status: 'done' })).approve).toBe(false);
  });
});
