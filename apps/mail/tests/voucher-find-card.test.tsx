/**
 * @vitest-environment happy-dom
 */
import {
  canSearchVoucher,
  VOUCHER_COPY,
  voucherConflictLines,
  voucherFindClientFromTrpc,
  voucherGuestLine,
  type VoucherFindReply,
} from '../lib/quote-workflow/voucher-find';
import {
  formatStayDate,
  noSearchMatchCopy,
  type FindStayInput,
  type FindStayReply,
  type GuestSearchInput,
  type GuestSearchReply,
  type HmsJobView,
} from '../lib/quote-workflow/amend-find';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VoucherFindCard as ScopedVoucherFindCard, VOUCHER_ATTACH_COPY } from '../components/quote-workflow/voucher-find-card';
import * as attachmentAccess from '../lib/attachment-access';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unmaskedPii } from './helpers/pii-marks';

let restoreClipboard: () => void = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreClipboard();
  restoreClipboard = () => {};
});

const AS_OF = '2026-10-09T08:05:00.000Z';
const MAILBOX = { context: { activeTransportId: 'transport-1' } };
const DOCUMENT_SOURCE = { sha256: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64) };
const SELECTED_SOURCE = { threadId: 'thread-1', messageId: 'm1', sourceHash: 'c'.repeat(64) };

function VoucherFindCard(props: ComponentProps<typeof ScopedVoucherFindCard>) {
  return <ScopedVoucherFindCard transportId="transport-1" mailboxScope="user-1:session-1:transport-1"
    {...(props.propertyCode === 'HRCEN' ? { selectedSource: SELECTED_SOURCE } : {})} {...props} />;
}

const PDF = { id: 'att-1', filename: 'Smith_VCH_1879000.pdf', mimeType: 'application/pdf', sizeBytes: 100 };
const VOUCHER: VoucherFindReply = {
  status: 'voucher',
  messageId: 'm1',
  threadId: 'thread-1',
  guest: { lastName: 'Smith', arrival: '2026-11-12' },
  file: PDF,
  files: [PDF],
  documentSource: DOCUMENT_SOURCE,
};

const SMITH_ROW = {
  confirmation: '57291630-1',
  lastName: 'Smith',
  firstName: 'John',
  status: 'Reserved',
  arrival: '2026-11-12',
  departure: '2026-11-14',
};
const SMITH_FIND: FindStayReply = {
  outcome: 'found', reason: null, stay: { ...SMITH_ROW, nights: 2, adults: 2, children: 0,
    roomType: 'STQN', ratePlan: 'BAR', mealPlan: null, averageRate: null, grandTotal: null,
    balance: null, sourceOfBusiness: null, guaranteeType: null, bookingAgency: null, organization: null },
  screenshots: [], runId: null, arrivalMismatch: false,
  requestedArrival: SMITH_ROW.arrival, hmsArrival: SMITH_ROW.arrival,
};

type JobStatusQuery = (input: {
  threadId: string;
  messageId?: string;
  kind: 'find' | 'search_guest' | 'availability';
  confirmation?: string;
  lastName?: string;
  arrival?: string;
  departure?: string | null;
}) => Promise<HmsJobView | null>;

// The trpc client the pane passes in: the voucher check and the guest-name search job routes, and nothing else.
// Each queued search runs its mock and is stored as a finished job, so jobStatus answers on the first poll.
function fakeTrpc(options: {
  reply: VoucherFindReply;
  search?: GuestSearchReply;
  find?: FindStayReply;
  resumed?: HmsJobView | null;
  status?: JobStatusQuery;
  /** The server's job queue is off: queueSearchGuest queues nothing and returns no run id. */
  queueOff?: boolean;
}) {
  const voucherFind = vi.fn(async (_input: { internetMessageId: string; attachmentId?: string }): Promise<VoucherFindReply> =>
    options.reply.status === 'voucher' ? { ...options.reply,
      files: options.reply.files ?? (options.reply.file ? [options.reply.file] : []) } : options.reply);
  const searchGuest = vi.fn(
    async (_input: { lastName: string; arrival: string; departure?: string }) =>
      options.search ?? { outcome: 'ok', rows: [SMITH_ROW], screenshots: [], runId: null },
  );
  const findStay = vi.fn(async (_input: FindStayInput) => options.find ?? SMITH_FIND);
  const jobs = new Map<string, HmsJobView>();
  if (options.resumed) jobs.set(options.resumed.runId, options.resumed);
  let issued = 0;
  const queueSearchGuest = vi.fn(async ({
    threadId: _threadId,
    autoStart: _autoStart,
    ...input
  }: GuestSearchInput & { threadId: string; autoStart?: true }) => {
    if (options.queueOff) return { runId: null };
    const reply = await searchGuest(input);
    const runId = `run-${++issued}`;
    jobs.set(runId, {
      runId,
      sourceMessageId: input.messageId,
      sourceHash: input.sourceHash,
      request: { kind: 'search_guest', ...input },
      prefetch: false,
      status: 'done',
      position: null,
      attempts: 1,
      failureClass: null,
      asOf: AS_OF,
      result: { ...reply, kind: 'search_guest', asOf: AS_OF },
    });
    return { runId };
  });
  const queueFind = vi.fn(async ({
    threadId: _threadId,
    autoStart: _autoStart,
    ...input
  }: FindStayInput & { threadId: string; autoStart?: true }) => {
    if (options.queueOff) return { runId: null };
    const reply = await findStay(input);
    const runId = `run-${++issued}`;
    jobs.set(runId, {
      runId,
      sourceMessageId: input.messageId,
      sourceHash: input.sourceHash,
      request: { kind: 'find', ...input },
      prefetch: false,
      status: 'done',
      position: null,
      attempts: 1,
      failureClass: null,
      asOf: AS_OF,
      result: { ...reply, kind: 'find', asOf: AS_OF },
    });
    return { runId };
  });
  return {
    trpc: {
      quoteWorkflow: { voucherFind: { query: voucherFind }, bindVoucherAttach: { mutate: vi.fn() } },
      hmsApproval: { writeState: { query: vi.fn(async () => ({ run: null, needsCheck: false })) } },
      paneStayLookup: {
        queueFind: { mutate: queueFind },
        queueSearchGuest: { mutate: queueSearchGuest },
        findStay: { mutate: findStay },
        searchGuest: { mutate: searchGuest },
        jobStatus: {
          query: async (
            input:
              | { runId: string }
              | {
                  threadId: string;
                  kind: 'find' | 'search_guest' | 'availability';
                  confirmation?: string;
                  lastName?: string;
                  arrival?: string;
                  departure?: string | null;
                },
          ) => {
            if ('runId' in input) return jobs.get(input.runId) ?? null;
            if ('threadId' in input && options.status) return options.status(input);
            if (input.kind === 'find') {
              return [...jobs.values()].find((view) =>
                view.request?.kind === 'find' &&
                view.request.confirmation === input.confirmation &&
                (!input.arrival || view.request.arrival === input.arrival),
              ) ?? null;
            }
            const found = options.resumed ?? null;
            if (found?.request?.kind !== 'search_guest') return null;
            if (input.lastName && found.request.lastName.toLowerCase() !== input.lastName.toLowerCase()) return null;
            if (input.arrival && found.request.arrival !== input.arrival) return null;
            if ('departure' in input && (found.request.departure ?? null) !== input.departure) return null;
            return found;
          },
        },
        screenshot: { query: vi.fn() },
      },
    },
    voucherFind,
    findStay,
    queueFind,
    searchGuest,
    queueSearchGuest,
  };
}

// The job routes alone, for the sync cases that never run a search.
const jobRoutesOnly = () => fakeTrpc({ reply: VOUCHER }).trpc.paneStayLookup;

async function chooseCloudBooking() {
  if (!screen.queryByRole('button', { name: 'Selected' })) {
    fireEvent.click(await screen.findByRole('button', { name: 'Select booking' }));
  }
}

describe('voucher find card: what shows', () => {
  it('renders nothing when the email is not a voucher or is not synced', async () => {
    for (const reply of [{ status: 'not_voucher' as const }, { status: 'unsynced' as const }]) {
      const { trpc } = fakeTrpc({ reply });
      const { container, unmount } = render(
        <VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />,
      );
      await waitFor(() => expect(container.querySelector('section')).toBeNull());
      expect(container.textContent).toBe('');
      unmount();
    }
  });

  it('shows the guest, automatically finds one booking, and keeps the save action and file name', async () => {
    const { trpc, searchGuest } = fakeTrpc({ reply: VOUCHER });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(screen.getByText(`Guest Smith · arriving ${formatStayDate('2026-11-12')}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: VOUCHER_COPY.save })).toBeTruthy();
    expect(screen.getByText('Smith_VCH_1879000.pdf')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy confirmation' })).toBeTruthy();
    const saveAndMatch = screen.getByTestId('voucher-save-and-match');
    expect(saveAndMatch.contains(screen.getByRole('button', { name: VOUCHER_COPY.save }))).toBe(true);
    expect(saveAndMatch.contains(screen.getByRole('button', { name: 'Copy confirmation' }))).toBe(true);
    expect(searchGuest).toHaveBeenCalledWith({
      lastName: 'Smith',
      arrival: '2026-11-12',
      messageId: 'm1',
    });
  });

  it('says what it could not read and offers no search when the surname or arrival is missing', async () => {
    const { trpc: noName } = fakeTrpc({
      reply: { ...VOUCHER, guest: { lastName: null, arrival: '2026-11-12' } },
    });
    const first = render(
      <VoucherFindCard internetMessageId="abc@host" trpc={noName} download={vi.fn()} />,
    );
    expect(await screen.findByText(VOUCHER_COPY.missingGuest)).toBeTruthy();
    expect(screen.queryByRole('button', { name: VOUCHER_COPY.search })).toBeNull();
    first.unmount();

    const { trpc: noArrival } = fakeTrpc({
      reply: { ...VOUCHER, guest: { lastName: 'Smith', arrival: null } },
    });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={noArrival} download={vi.fn()} />);
    expect(await screen.findByText(VOUCHER_COPY.missingArrival)).toBeTruthy();
    expect(screen.queryByRole('button', { name: VOUCHER_COPY.search })).toBeNull();
  });

  it('a new email clears the card before its own answer arrives', async () => {
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    const { rerender, container } = render(
      <VoucherFindCard internetMessageId="first@host" trpc={trpc} download={vi.fn()} />,
    );
    expect(await screen.findByRole('button', { name: VOUCHER_COPY.save })).toBeTruthy();
    rerender(<VoucherFindCard internetMessageId={null} trpc={trpc} download={vi.fn()} />);
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });
});

describe('voucher find card: the existing search', () => {
  it('starts the existing guest search on open, with the surname and arrival', async () => {
    const { trpc, searchGuest, queueSearchGuest } = fakeTrpc({ reply: VOUCHER });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('John Smith · 57291630-1')).toBeTruthy());
    expect(searchGuest).toHaveBeenCalledTimes(1);
    expect(searchGuest).toHaveBeenCalledWith({
      lastName: 'Smith',
      arrival: '2026-11-12',
      messageId: 'm1',
    });
    expect(queueSearchGuest).toHaveBeenCalledWith({
      threadId: 'thread-1',
      messageId: 'm1',
      lastName: 'Smith',
      arrival: '2026-11-12',
      autoStart: true,
    }, MAILBOX);
    expect(screen.queryByRole('button', { name: VOUCHER_COPY.search })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy confirmation' })).toBeTruthy();
  });

  it('reads commercial parties by exact confirmation only after staff requests booking details', async () => {
    const find: FindStayReply = {
      outcome: 'found',
      reason: null,
      stay: {
        status: 'Reserved',
        confirmation: '57291630-1',
        lastName: 'Smith',
        firstName: 'John',
        arrival: '2026-11-12',
        departure: '2026-11-14',
        nights: 2,
        adults: 2,
        children: 0,
        roomType: 'STQN',
        ratePlan: 'CORP10',
        mealPlan: 'BB',
        averageRate: '1250.00',
        grandTotal: null,
        balance: null,
        sourceOfBusiness: 'Travel Agency',
        guaranteeType: null,
        bookingAgency: null,
        organization: null,
      },
      commercial: {
        company: { name: 'Northstar Conference Group', nativeId: 'COMP-42' },
        agency: { name: 'Harbor Travel', nativeId: 'AG-9' },
      },
      screenshots: [],
      runId: null,
      arrivalMismatch: false,
      requestedArrival: '2026-11-12',
      hmsArrival: '2026-11-12',
    };
    const { trpc, queueFind } = fakeTrpc({ reply: VOUCHER, find });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);

    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(queueFind).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: VOUCHER_COPY.readDetails }));

    expect(await screen.findByText('Company: Northstar Conference Group')).toBeTruthy();
    expect(screen.getByText('Booking agency: Harbor Travel')).toBeTruthy();
    expect(queueFind).toHaveBeenCalledWith({
      threadId: 'thread-1',
      messageId: 'm1',
      confirmation: '57291630-1',
      arrival: '2026-11-12',
    }, MAILBOX);
  });

  it('passes the selected voucher message id on guest search and stay find', async () => {
    const { trpc, queueSearchGuest, queueFind, searchGuest, findStay } = fakeTrpc({
      reply: VOUCHER,
      queueOff: true,
    });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: VOUCHER_COPY.search }));
    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(queueSearchGuest).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-1', messageId: 'm1', lastName: 'Smith' }),
      MAILBOX,
    );
    expect(searchGuest).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-1', messageId: 'm1', lastName: 'Smith' }),
      MAILBOX,
    );
    fireEvent.click(await screen.findByRole('button', { name: VOUCHER_COPY.readDetails }));
    await waitFor(() =>
      expect(queueFind).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1',
          messageId: 'm1',
          confirmation: '57291630-1',
        }),
        MAILBOX,
      ),
    );
    expect(findStay).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        messageId: 'm1',
        confirmation: '57291630-1',
      }),
      MAILBOX,
    );
  });

  it('with the job queue off, opening the card runs no HMS search and the Find button runs one on click', async () => {
    const { trpc, searchGuest, queueSearchGuest } = fakeTrpc({ reply: VOUCHER, queueOff: true });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    await waitFor(() => expect(queueSearchGuest).toHaveBeenCalledWith(expect.objectContaining({ autoStart: true }), MAILBOX));
    expect(searchGuest).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: VOUCHER_COPY.search }));
    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(searchGuest).toHaveBeenCalledTimes(1);
    expect(searchGuest).toHaveBeenCalledWith({
      lastName: 'Smith',
      arrival: '2026-11-12',
      threadId: 'thread-1',
      messageId: 'm1',
    }, MAILBOX);
  });

  it('hydrates a matching prefetched result on open and never queues another lookup', async () => {
    const prefetched: HmsJobView = {
      runId: 'prefetch-1',
      sourceMessageId: 'm1',
      request: { kind: 'search_guest', lastName: 'Smith', arrival: '2026-11-12' },
      prefetch: true,
      status: 'done',
      position: null,
      attempts: 1,
      failureClass: null,
      asOf: AS_OF,
      result: { outcome: 'ok', rows: [SMITH_ROW], screenshots: [], runId: null },
    };
    const { trpc, searchGuest, queueSearchGuest } = fakeTrpc({ reply: VOUCHER, resumed: prefetched });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);

    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(screen.getByTestId('hms-as-of').textContent).toMatch(/^Looked up in HMS /);
    expect(searchGuest).not.toHaveBeenCalled();
    expect(queueSearchGuest).not.toHaveBeenCalled();
  });

  it('rejects a same-thread result from another email and scopes resume and polling to this mailbox', async () => {
    const wrong: HmsJobView = {
      runId: 'other-email', sourceMessageId: 'm2',
      request: { kind: 'search_guest', lastName: 'Smith', arrival: '2026-11-12' },
      prefetch: true, status: 'done', position: null, attempts: 1, failureClass: null, asOf: AS_OF,
      result: { outcome: 'ok', rows: [{ ...SMITH_ROW, firstName: 'Wrong' }], screenshots: [], runId: null },
    };
    const { trpc, queueSearchGuest } = fakeTrpc({ reply: VOUCHER, resumed: wrong });
    const status = vi.spyOn(trpc.paneStayLookup.jobStatus, 'query');
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);

    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(screen.queryByText('Wrong Smith · 57291630-1')).toBeNull();
    expect(queueSearchGuest).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm1' }), MAILBOX);
    expect(status).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1', messageId: 'm1', kind: 'search_guest',
    }), MAILBOX);
    expect(status).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1', messageId: 'm1', runId: 'run-1',
    }), MAILBOX);
  });

  it('does not search or offer a preview without a selected source message', async () => {
    const { trpc, queueSearchGuest } = fakeTrpc({ reply: { ...VOUCHER, messageId: '' } });
    (trpc as { hmsApproval?: unknown }).hmsApproval = { previewAttach: { mutate: vi.fn() },
      writeState: { query: vi.fn(async () => ({ run: null, needsCheck: false })) } };
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId="wi-1" propertyCode="HRCEN" />);
    expect(await screen.findByText('Find the booking and review the document before upload.')).toBeTruthy();
    await act(async () => {});
    expect(queueSearchGuest).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Check document and booking' })).toBeNull();
  });

  it('keeps Find hidden until a slow read-back settles, then shows the existing result', async () => {
    const prefetched: HmsJobView = {
      runId: 'prefetch-slow',
      sourceMessageId: 'm1',
      request: { kind: 'search_guest', lastName: 'Smith', arrival: '2026-11-12' },
      prefetch: true,
      status: 'done',
      position: null,
      attempts: 1,
      failureClass: null,
      asOf: AS_OF,
      result: { outcome: 'ok', rows: [SMITH_ROW], screenshots: [], runId: null },
    };
    let answerRead: (job: HmsJobView | null) => void = () => {};
    const status = vi.fn<JobStatusQuery>(
      () =>
        new Promise<HmsJobView | null>((resolve) => {
          answerRead = resolve;
        }),
    );
    const { trpc, searchGuest, queueSearchGuest } = fakeTrpc({ reply: VOUCHER, status });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);

    // The read-back is still in flight: the card is up, and there is no Find button a click could queue a search from.
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    expect(screen.getByText(VOUCHER_COPY.caption)).toBeTruthy();
    expect(screen.queryByRole('button', { name: VOUCHER_COPY.search })).toBeNull();

    answerRead(prefetched);
    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: VOUCHER_COPY.search })).toBeNull();
    expect(searchGuest).not.toHaveBeenCalled();
    expect(queueSearchGuest).not.toHaveBeenCalled();
  });

  it('keeps a single surname-mismatching row as a candidate instead of promoting it to a voucher match', async () => {
    const unrelated = { ...SMITH_ROW, lastName: 'Jones', firstName: 'Jane' };
    const { trpc } = fakeTrpc({ reply: VOUCHER, search: { outcome: 'ok', rows: [unrelated], screenshots: [], runId: null } });
    const { container } = render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);

    expect(await screen.findByText('Jane Jones · 57291630-1')).toBeTruthy();
    expect(screen.getByText(VOUCHER_COPY.pickRow)).toBeTruthy();
    expect(container.querySelector('[data-testid="voucher-matched-booking"]')).toBeNull();
  });

  it('does not promote a narrower one-row search when an unfiltered search is ambiguous', async () => {
    const narrow: HmsJobView = {
      runId: 'narrow-1',
      sourceMessageId: 'm1',
      request: { kind: 'search_guest', lastName: 'Smith', arrival: '2026-11-12', departure: '2026-11-14' },
      prefetch: false,
      status: 'done',
      position: null,
      attempts: 1,
      failureClass: null,
      asOf: AS_OF,
      result: { outcome: 'ok', rows: [SMITH_ROW], screenshots: [], runId: null },
    };
    const secondRow = { ...SMITH_ROW, confirmation: '57291630-2', firstName: 'James' };
    const status = vi.fn<JobStatusQuery>(async ({ departure }) => (departure === null ? null : narrow));
    const { trpc, searchGuest, queueSearchGuest } = fakeTrpc({
      reply: VOUCHER,
      resumed: narrow,
      status,
      search: { outcome: 'ok', rows: [SMITH_ROW, secondRow], screenshots: [], runId: null },
    });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);

    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(screen.getByText('James Smith · 57291630-2')).toBeTruthy();
    expect(screen.getByText(VOUCHER_COPY.pickRow)).toBeTruthy();
    expect(screen.queryByTestId('voucher-matched-booking')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Copy confirmation' })).toHaveLength(2);
    expect(status).toHaveBeenCalledWith({
      threadId: 'thread-1',
      messageId: 'm1',
      kind: 'search_guest',
      lastName: 'Smith',
      arrival: '2026-11-12',
      departure: null,
    });
    expect(queueSearchGuest).toHaveBeenCalledWith({
      threadId: 'thread-1',
      messageId: 'm1',
      lastName: 'Smith',
      arrival: '2026-11-12',
      autoStart: true,
    }, MAILBOX);
    expect(searchGuest).toHaveBeenCalledWith({
      lastName: 'Smith',
      arrival: '2026-11-12',
      messageId: 'm1',
    });
  });

  it('surfaces a failed resume read and retries it before queueing', async () => {
    const status = vi
      .fn<JobStatusQuery>()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(null);
    const { trpc, queueSearchGuest } = fakeTrpc({ reply: VOUCHER, status });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);

    expect(await screen.findByText('Could not check for an existing HMS lookup.')).toBeTruthy();
    expect(queueSearchGuest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(queueSearchGuest).toHaveBeenCalledTimes(1));
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('uses a retry status read to hydrate a job instead of creating a duplicate', async () => {
    const prefetched: HmsJobView = {
      runId: 'prefetch-after-retry',
      sourceMessageId: 'm1',
      request: { kind: 'search_guest', lastName: 'Smith', arrival: '2026-11-12' },
      prefetch: true,
      status: 'done',
      position: null,
      attempts: 1,
      failureClass: null,
      asOf: AS_OF,
      result: { outcome: 'ok', rows: [SMITH_ROW], screenshots: [], runId: null },
    };
    const status = vi
      .fn<JobStatusQuery>()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(prefetched);
    const { trpc, queueSearchGuest } = fakeTrpc({ reply: VOUCHER, status });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);

    expect(await screen.findByText('Could not check for an existing HMS lookup.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(queueSearchGuest).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('copies only the matched confirmation and opens the configured HMS landing page', async () => {
    const landing = 'https://hms.example.test/';
    vi.stubEnv('VITE_PUBLIC_HMS_LANDING_URL', landing);
    const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    restoreClipboard = () => {
      if (prior) Object.defineProperty(navigator, 'clipboard', prior);
      else Reflect.deleteProperty(navigator, 'clipboard');
    };
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    await screen.findByText('John Smith · 57291630-1');
    fireEvent.click(screen.getByRole('button', { name: 'Copy confirmation' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('57291630-1'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open in HMS' }).getAttribute('href')).toBe(landing);
  });

  it('shows multiple matches without choosing one for the attachment row', async () => {
    const secondRow = { ...SMITH_ROW, confirmation: '57291630-2', firstName: 'James' };
    const { trpc } = fakeTrpc({
      reply: VOUCHER,
      search: { outcome: 'ok', rows: [SMITH_ROW, secondRow], screenshots: [], runId: null },
    });
    render(
      <VoucherFindCard
        internetMessageId="abc@host"
        trpc={trpc}
        download={vi.fn()}
        workItemId="wi-1"
        propertyCode="HRDAV"
        writesEnabled
      />,
    );

    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(screen.getByText('James Smith · 57291630-2')).toBeTruthy();
    expect(screen.getByText(VOUCHER_COPY.pickRow)).toBeTruthy();
    expect(screen.queryByTestId('voucher-matched-booking')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Copy confirmation' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Attach to HMS booking' })).toBeNull();
  });

  it('checks an entered confirmation in HMS and requires an explicit booking selection', async () => {
    const reply: VoucherFindReply = {
      ...VOUCHER,
      guest: { lastName: 'Smith', arrival: '2026-11-12' },
    };
    const { trpc, searchGuest, queueFind } = fakeTrpc({
      reply,
      search: { outcome: 'ok', rows: [], screenshots: [], runId: null },
    });
    (trpc as { hmsApproval?: unknown }).hmsApproval = { previewAttach: { mutate: vi.fn() } };
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()}
      propertyCode="HRCEN" workItemId="wi-1" />);
    await waitFor(() =>
      expect(screen.getByText(noSearchMatchCopy('Smith', '2026-11-12'))).toBeTruthy(),
    );
    // The voucher reference 1879000 in the file name is not a booking, so no copy action appears.
    expect(screen.queryByRole('button', { name: 'Copy confirmation' })).toBeNull();
    expect(searchGuest).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Confirmation number'), { target: { value: SMITH_ROW.confirmation } });
    fireEvent.click(screen.getByRole('button', { name: 'Find by confirmation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Select booking' }));
    expect(await screen.findByRole('button', { name: 'Check document and booking' })).toBeTruthy();
    expect(queueFind).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByLabelText('Arrival'), { target: { value: '2026-11-13' } });
    expect(screen.queryByRole('button', { name: 'Check document and booking' })).toBeNull();
  });

  it('shows a plain failure when the search call fails', async () => {
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    trpc.paneStayLookup.queueSearchGuest.mutate = vi.fn(async () => {
      throw new Error('socket closed');
    });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    expect(await screen.findByText(/could not read the HMS search/i)).toBeTruthy();
  });

  it('retries an auto-start after the queue call fails', async () => {
    const { trpc, queueSearchGuest } = fakeTrpc({ reply: VOUCHER });
    queueSearchGuest.mockRejectedValueOnce(new Error('temporary queue failure'));
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);

    expect(await screen.findByText(/could not read the HMS search/i)).toBeTruthy();
    expect(queueSearchGuest).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(queueSearchGuest).toHaveBeenCalledTimes(2);
    const idempotentAutoStart = {
      threadId: 'thread-1',
      messageId: 'm1',
      lastName: 'Smith',
      arrival: '2026-11-12',
      autoStart: true,
    };
    expect(queueSearchGuest).toHaveBeenNthCalledWith(1, idempotentAutoStart, MAILBOX);
    expect(queueSearchGuest).toHaveBeenNthCalledWith(2, idempotentAutoStart, MAILBOX);
  });

  it("never reads back another guest's search from the same thread, and still reads back this guest's", async () => {
    const { trpc, searchGuest } = fakeTrpc({ reply: VOUCHER });
    searchGuest.mockImplementation(async ({ lastName }) => ({
      outcome: 'ok',
      rows: lastName === 'Jones' ? [{ ...SMITH_ROW, lastName: 'Jones', firstName: 'Jane' }] : [SMITH_ROW],
      screenshots: [],
      runId: null,
    }));
    const JONES: VoucherFindReply = { ...VOUCHER, messageId: 'm2', guest: { lastName: 'Jones', arrival: '2026-11-12' } };
    trpc.quoteWorkflow.voucherFind.query = vi.fn(async ({ internetMessageId }: { internetMessageId: string }) =>
      internetMessageId === 'second@host' ? JONES : VOUCHER,
    );
    // The latest search_guest job on the thread, filtered by arrival as the server does.
    const byRun = trpc.paneStayLookup.jobStatus.query;
    const latest: HmsJobView[] = [];
    const queue = trpc.paneStayLookup.queueSearchGuest.mutate;
    trpc.paneStayLookup.queueSearchGuest.mutate = vi.fn(async (input) => {
      const started = await queue(input);
      const view = await byRun({ runId: started.runId! });
      if (view) latest.unshift(view);
      return started;
    });
    trpc.paneStayLookup.jobStatus.query = async (input: { runId: string } | { threadId: string; lastName?: string; arrival?: string }) =>
      'runId' in input
        ? byRun(input)
        : (latest.find(
            (view) =>
              view.request?.kind === 'search_guest' &&
              (!input.arrival || view.request.arrival === input.arrival) &&
              (!input.lastName ||
                view.request.lastName.toLowerCase() === input.lastName.toLowerCase()),
          ) ?? null);

    const { rerender } = render(<VoucherFindCard internetMessageId="first@host" trpc={trpc} download={vi.fn()} />);
    await screen.findByText('John Smith · 57291630-1');

    rerender(<VoucherFindCard internetMessageId="second@host" trpc={trpc} download={vi.fn()} />);
    await screen.findByText(`Guest Jones · arriving ${formatStayDate('2026-11-12')}`);
    // Give the read-back time to answer: Smith's rows must not appear under Jones.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('John Smith · 57291630-1')).toBeNull();

    rerender(<VoucherFindCard internetMessageId="first@host" trpc={trpc} download={vi.fn()} />);
    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
  });
});

describe('voucher find card: saving the file', () => {
  it('downloads the scoped attachment after the pinned URL and bytes both arrive', async () => {
    const getAttachment = vi.fn(async () => ({ url: 'https://example.test/attachment' }));
    const blob = new Blob(['%PDF-test'], { type: 'application/pdf' });
    const fetchBytes = vi.fn(async () => ({ ok: true, blob: async () => blob }));
    const trigger = vi.spyOn(attachmentAccess, 'triggerBlobDownload').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchBytes);
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { mail?: unknown }).mail = { getAttachment: { query: getAttachment } };
    render(<ScopedVoucherFindCard internetMessageId="abc@host" trpc={trpc}
      transportId="transport-1" mailboxScope="user-1:session-1:transport-1" />);
    fireEvent.click(await screen.findByRole('button', { name: VOUCHER_COPY.save }));
    await waitFor(() => expect(trigger).toHaveBeenCalledWith(blob, 'Smith_VCH_1879000.pdf'));
    expect(getAttachment).toHaveBeenCalledWith({ messageId: 'm1', attachmentId: 'att-1' },
      expect.objectContaining({ context: MAILBOX.context, signal: expect.anything() }));
    expect(fetchBytes).toHaveBeenCalledWith('https://example.test/attachment', { signal: expect.anything() });
  });

  it('pins the attachment request and ignores its late URL after an actor switch', async () => {
    let resolveUrl!: (result: { url: string }) => void;
    let signal!: AbortSignal;
    const getAttachment = vi.fn((_input: { messageId: string; attachmentId: string }, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise<{ url: string }>((resolve) => { resolveUrl = resolve; });
    });
    const fetchBytes = vi.fn();
    vi.stubGlobal('fetch', fetchBytes);
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { mail?: unknown }).mail = { getAttachment: { query: getAttachment } };
    const { rerender } = render(<ScopedVoucherFindCard internetMessageId="abc@host" trpc={trpc}
      transportId="transport-1" mailboxScope="user-1:session-1:transport-1" />);
    fireEvent.click(await screen.findByRole('button', { name: VOUCHER_COPY.save }));
    await waitFor(() => expect(getAttachment).toHaveBeenCalledTimes(1));
    expect(getAttachment).toHaveBeenCalledWith({ messageId: 'm1', attachmentId: 'att-1' },
      expect.objectContaining({ context: MAILBOX.context, signal: expect.anything() }));
    rerender(<ScopedVoucherFindCard internetMessageId="abc@host" trpc={trpc}
      transportId="transport-1" mailboxScope="user-2:session-2:transport-1" />);
    expect(signal.aborted).toBe(true);
    await act(async () => resolveUrl({ url: 'https://example.test/attachment' }));
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('aborts an in-flight attachment fetch when the mailbox changes', async () => {
    const getAttachment = vi.fn(async () => ({ url: 'https://example.test/attachment' }));
    let signal!: AbortSignal;
    const fetchBytes = vi.fn((_url: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    vi.stubGlobal('fetch', fetchBytes);
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { mail?: unknown }).mail = { getAttachment: { query: getAttachment } };
    const { rerender } = render(<ScopedVoucherFindCard internetMessageId="abc@host" trpc={trpc}
      transportId="transport-1" mailboxScope="user-1:session-1:transport-1" />);
    fireEvent.click(await screen.findByRole('button', { name: VOUCHER_COPY.save }));
    await waitFor(() => expect(fetchBytes).toHaveBeenCalledTimes(1));
    rerender(<ScopedVoucherFindCard internetMessageId="abc@host" trpc={trpc}
      transportId="transport-2" mailboxScope="user-1:session-1:transport-2" />);
    expect(signal.aborted).toBe(true);
  });

  it('downloads the voucher file by its attachment id, and says to upload it in HMS Documents', async () => {
    const download = vi.fn(async () => {});
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={download} />);
    fireEvent.click(await screen.findByRole('button', { name: VOUCHER_COPY.save }));
    expect(await screen.findByText(VOUCHER_COPY.saved)).toBeTruthy();
    expect(download).toHaveBeenCalledWith({
      messageId: 'm1',
      attachmentId: 'att-1',
      filename: 'Smith_VCH_1879000.pdf',
      mimeType: 'application/pdf',
      size: 100,
    });
  });

  it('says so when the download fails', async () => {
    const download = vi.fn(async () => {
      throw new Error('Failed to fetch attachment: 403');
    });
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={download} />);
    fireEvent.click(await screen.findByRole('button', { name: VOUCHER_COPY.save }));
    expect(await screen.findByText(VOUCHER_COPY.saveFailed)).toBeTruthy();
  });

  it('offers no save action when the email has no file', async () => {
    const { trpc } = fakeTrpc({ reply: { ...VOUCHER, file: null, files: [] } });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    expect(await screen.findByText(VOUCHER_COPY.noFile)).toBeTruthy();
    expect(screen.queryByRole('button', { name: VOUCHER_COPY.save })).toBeNull();
  });
});

describe('voucher find card: attach to HMS', () => {
  const WORK_ITEM = '3f8a2c1e-9b7d-4e6f-8a1b-2c3d4e5f6a7b';

  it('uses the scoped filing flag to prepare a reviewed upload even when create is off', async () => {
    const preview = vi.fn(async () => ({ status: 'ready' as const, confirmation: SMITH_ROW.confirmation,
      arrival: SMITH_ROW.arrival, documentName: 'Smith_VCH_1879000.pdf', documentSource: DOCUMENT_SOURCE, revisionSeq: 0 }));
    const bind = vi.fn(async () => ({ status: 'bound' as const, formDigest: 'd'.repeat(64),
      form: { confirmation: SMITH_ROW.confirmation, arrival: SMITH_ROW.arrival, lastName: SMITH_ROW.lastName,
        attachmentId: 'att-1', documentName: PDF.filename, pdfSha256: DOCUMENT_SOURCE.sha256,
        sourceSnapshotDigest: DOCUMENT_SOURCE.snapshotDigest, sourceMessageId: 'm1',
        sourceThreadId: 'thread-1', sourceHash: SELECTED_SOURCE.sourceHash } }));
    const onPrepared = vi.fn();
    const state = vi.fn(async () => ({ form: { action: 'amend' }, grant: { fingerprintMatches: true },
      run: { state: 'succeeded', lastError: null, evidence: [] }, needsCheck: false, filingConfigured: true }));
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { hmsApproval?: unknown }).hmsApproval = { previewAttach: { mutate: preview },
      bindAttach: { mutate: bind }, writeState: { query: state } };
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId={WORK_ITEM} propertyCode="HRCEN"
      approvalAvailable onPrepared={onPrepared} />);
    await waitFor(() => expect(state).toHaveBeenCalled());
    await chooseCloudBooking();
    fireEvent.click(await screen.findByRole('button', { name: 'Check document and booking' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare upload for approval' }));
    await waitFor(() => expect(bind).toHaveBeenCalledWith({ workItemId: WORK_ITEM, sourceMessageId: 'm1',
      attachmentId: 'att-1', confirmation: SMITH_ROW.confirmation, arrival: SMITH_ROW.arrival,
      lastName: SMITH_ROW.lastName, internetMessageId: 'abc@host', selectedSource: SELECTED_SOURCE,
      documentSource: DOCUMENT_SOURCE, revisionSeq: 0 }, MAILBOX));
    expect(onPrepared).toHaveBeenCalledOnce();
  });

  it('does not prepare HRCEN filing when no matching approval card is mounted', async () => {
    const preview = vi.fn(async () => ({ status: 'ready' as const, confirmation: SMITH_ROW.confirmation,
      arrival: SMITH_ROW.arrival, documentName: 'Smith_VCH_1879000.pdf', documentSource: DOCUMENT_SOURCE, revisionSeq: 0 }));
    const bind = vi.fn(async () => ({ status: 'bound' as const, formDigest: 'd'.repeat(64),
      form: { confirmation: SMITH_ROW.confirmation, arrival: SMITH_ROW.arrival, lastName: SMITH_ROW.lastName,
        attachmentId: 'att-1', documentName: PDF.filename, pdfSha256: DOCUMENT_SOURCE.sha256,
        sourceSnapshotDigest: DOCUMENT_SOURCE.snapshotDigest, sourceMessageId: 'm1',
        sourceThreadId: 'thread-1', sourceHash: SELECTED_SOURCE.sourceHash } }));
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { hmsApproval?: unknown }).hmsApproval = { previewAttach: { mutate: preview }, bindAttach: { mutate: bind },
      writeState: { query: vi.fn(async () => ({ run: null, needsCheck: false, filingConfigured: true })) } };
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId={WORK_ITEM} propertyCode="HRCEN" />);
    await chooseCloudBooking();
    fireEvent.click(await screen.findByRole('button', { name: 'Check document and booking' }));
    expect(await screen.findByText(/Upload is not available yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Prepare upload for approval' })).toBeNull();
    expect(bind).not.toHaveBeenCalled();
  });

  it('discards a stale binding result and allows the new work item to be prepared', async () => {
    let resolveBind!: (value: { status: 'bound' }) => void;
    const preview = vi.fn(async () => ({ status: 'ready' as const, confirmation: SMITH_ROW.confirmation,
      arrival: SMITH_ROW.arrival, documentName: 'Smith_VCH_1879000.pdf', documentSource: DOCUMENT_SOURCE, revisionSeq: 0 }));
    const bind = vi.fn(() => new Promise<Parameters<typeof resolveBind>[0]>((done) => { resolveBind = done; }));
    const onPrepared = vi.fn();
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { hmsApproval?: unknown }).hmsApproval = { previewAttach: { mutate: preview }, bindAttach: { mutate: bind },
      writeState: { query: vi.fn(async () => ({ form: { action: 'attach_document' },
        grant: { fingerprintMatches: false }, run: { state: 'succeeded', lastError: null, evidence: [] },
        needsCheck: false, filingConfigured: true })) } };
    const { rerender } = render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId={WORK_ITEM}
      propertyCode="HRCEN" approvalAvailable onPrepared={onPrepared} />);
    await chooseCloudBooking();
    fireEvent.click(await screen.findByRole('button', { name: 'Check document and booking' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare upload for approval' }));
    await waitFor(() => expect(bind).toHaveBeenCalledOnce());
    rerender(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId="other-item"
      propertyCode="HRCEN" approvalAvailable onPrepared={onPrepared} />);
    await act(async () => resolveBind({ status: 'bound' }));
    expect(onPrepared).not.toHaveBeenCalled();
    await chooseCloudBooking();
    fireEvent.click(await screen.findByRole('button', { name: 'Check document and booking' }));
    expect((await screen.findByRole('button', { name: 'Prepare upload for approval' })).hasAttribute('disabled')).toBe(false);
  });

  it('holds preparation when the scoped filing flag is off, even if create is enabled', async () => {
    const preview = vi.fn(async () => ({ status: 'ready' as const, confirmation: SMITH_ROW.confirmation,
      arrival: SMITH_ROW.arrival, documentName: 'Smith_VCH_1879000.pdf', documentSource: DOCUMENT_SOURCE, revisionSeq: 0 }));
    const bind = vi.fn(async () => ({ status: 'bound' as const, formDigest: 'd'.repeat(64),
      form: { confirmation: SMITH_ROW.confirmation, arrival: SMITH_ROW.arrival, lastName: SMITH_ROW.lastName,
        attachmentId: 'att-1', documentName: PDF.filename, pdfSha256: DOCUMENT_SOURCE.sha256,
        sourceSnapshotDigest: DOCUMENT_SOURCE.snapshotDigest, sourceMessageId: 'm1',
        sourceThreadId: 'thread-1', sourceHash: SELECTED_SOURCE.sourceHash } }));
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { hmsApproval?: unknown }).hmsApproval = { previewAttach: { mutate: preview },
      bindAttach: { mutate: bind }, writeState: { query: vi.fn(async () => ({ run: null, filingConfigured: false })) } };
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId={WORK_ITEM} propertyCode="HRCEN" writesEnabled />);
    await chooseCloudBooking();
    fireEvent.click(await screen.findByRole('button', { name: 'Check document and booking' }));
    expect(await screen.findByText(/Upload is not available yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Prepare upload for approval' })).toBeNull();
    expect(bind).not.toHaveBeenCalled();
  });

  it('shows the confirmed listing while a safety hold blocks another upload', async () => {
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { hmsApproval?: unknown }).hmsApproval = { writeState: { query: vi.fn(async () => ({
      filingConfigured: true, form: { action: 'attach_document' }, needsCheck: true,
      run: { state: 'dead_letter', failureClass: 'UNKNOWN', lastError: 'confirmed_hold_unsettled', reviewed: 'flag', evidence: [] },
    })) } };
    const view = render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId={WORK_ITEM} propertyCode="HRCEN" />);
    expect(await screen.findByText(/HMS lists the document by code and name/)).toBeTruthy();
    expect((await screen.findByLabelText('Guest surname')).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Prepare upload for approval' })).toBeNull();
    view.unmount();
    const { trpc: completed } = fakeTrpc({ reply: VOUCHER });
    (completed as { hmsApproval?: unknown }).hmsApproval = { writeState: { query: vi.fn(async () => ({
      filingConfigured: true, form: { action: 'attach_document' }, grant: { fingerprintMatches: true }, needsCheck: false,
      run: { state: 'succeeded', lastError: null, evidence: [] },
    })) } };
    const completedView = render(<VoucherFindCard internetMessageId="abc@host" trpc={completed} workItemId={WORK_ITEM} propertyCode="HRCEN" />);
    await waitFor(() => expect(screen.getByLabelText('Guest surname').hasAttribute('disabled')).toBe(true));
    expect(screen.queryByRole('button', { name: 'Prepare upload for approval' })).toBeNull();
    completedView.unmount();
    const { trpc: unverified } = fakeTrpc({ reply: VOUCHER });
    (unverified as { hmsApproval?: unknown }).hmsApproval = { writeState: { query: vi.fn(async () => ({
      filingConfigured: true, form: { action: 'attach_document' }, grant: null, needsCheck: true,
      run: { state: 'succeeded', lastError: 'filing_approval_unverified', evidence: [] },
    })) } };
    const unverifiedView = render(<VoucherFindCard internetMessageId="abc@host" trpc={unverified} workItemId={WORK_ITEM} propertyCode="HRCEN" />);
    expect(await screen.findByText(VOUCHER_ATTACH_COPY.checkInInfor)).toBeTruthy();
    expect((await screen.findByLabelText('Guest surname')).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText(VOUCHER_ATTACH_COPY.documentsRow)).toBeNull();
    unverifiedView.unmount();
    const { trpc: flagged } = fakeTrpc({ reply: VOUCHER });
    const flaggedState = vi.fn(async () => ({
      filingConfigured: true, form: { action: 'attach_document' }, grant: { fingerprintMatches: true }, needsCheck: false,
      run: { state: 'succeeded', lastError: null, reviewed: 'flag', evidence: [] },
    }));
    (flagged as { hmsApproval?: unknown }).hmsApproval = { writeState: { query: flaggedState } };
    render(<VoucherFindCard internetMessageId="abc@host" trpc={flagged} workItemId={WORK_ITEM} propertyCode="HRCEN" />);
    await waitFor(() => expect(flaggedState).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByLabelText('Guest surname').hasAttribute('disabled')).toBe(false);
  });

  it('reviews the exact selected document and shows Go unavailable without enabling writes', async () => {
    const preview = vi.fn(async () => ({ status: 'ready' as const, confirmation: SMITH_ROW.confirmation,
      arrival: SMITH_ROW.arrival, documentName: 'Smith_VCH_1879000.pdf', documentSource: DOCUMENT_SOURCE, revisionSeq: 0 }));
    const { trpc, queueFind } = fakeTrpc({ reply: VOUCHER });
    (trpc as { hmsApproval?: unknown }).hmsApproval = { previewAttach: { mutate: preview } };
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId={WORK_ITEM} propertyCode="HRCEN" />);
    await screen.findByRole('button', { name: 'Select booking' });
    expect(screen.queryByRole('button', { name: 'Check document and booking' })).toBeNull();
    await chooseCloudBooking();
    fireEvent.click(await screen.findByRole('button', { name: 'Check document and booking' }));
    expect(queueFind).toHaveBeenCalledWith({ threadId: 'thread-1', messageId: 'm1',
      confirmation: SMITH_ROW.confirmation, arrival: SMITH_ROW.arrival, sourceHash: SELECTED_SOURCE.sourceHash }, MAILBOX);
    expect(await screen.findByText('Document available. Booking found. Check they belong together. Upload is not available yet.')).toBeTruthy();
    expect(preview).toHaveBeenCalledWith({ workItemId: WORK_ITEM, sourceMessageId: 'm1', attachmentId: 'att-1',
      confirmation: SMITH_ROW.confirmation, arrival: SMITH_ROW.arrival, lastName: SMITH_ROW.lastName,
      selectedSource: SELECTED_SOURCE, documentSource: DOCUMENT_SOURCE }, MAILBOX);
    expect(screen.queryByRole('button', { name: 'Go' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach to HMS booking' })).toBeNull();
  });

  it('does not show a stale preview after the selected work item changes', async () => {
    let resolve!: (value: { status: 'ready'; confirmation: string; arrival: string; documentName: string;
      documentSource: typeof DOCUMENT_SOURCE; revisionSeq: number }) => void;
    const preview = vi.fn(() => new Promise<Parameters<typeof resolve>[0]>((done) => { resolve = done; }));
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { hmsApproval?: unknown }).hmsApproval = { previewAttach: { mutate: preview } };
    const { rerender } = render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId={WORK_ITEM} propertyCode="HRCEN" />);
    await chooseCloudBooking();
    fireEvent.click(await screen.findByRole('button', { name: 'Check document and booking' }));
    rerender(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId="other-item" propertyCode="HRCEN" />);
    await act(async () => resolve({ status: 'ready', confirmation: SMITH_ROW.confirmation,
      arrival: SMITH_ROW.arrival, documentName: 'Smith_VCH_1879000.pdf', documentSource: DOCUMENT_SOURCE, revisionSeq: 0 }));
    expect(screen.queryByText('Document available. Booking found. Check they belong together. Upload is not available yet.')).toBeNull();
  });

  it('hides a ready preview if an upload is later found to be unconfirmed', async () => {
    let resolveState!: (value: { run: { state: string; lastError: string; evidence: { name: string }[] } }) => void;
    const writeState = vi.fn(() => new Promise<Parameters<typeof resolveState>[0]>((done) => { resolveState = done; }));
    const preview = vi.fn(async () => ({ status: 'ready' as const, confirmation: SMITH_ROW.confirmation,
      arrival: SMITH_ROW.arrival, documentName: 'Smith_VCH_1879000.pdf', documentSource: DOCUMENT_SOURCE, revisionSeq: 0 }));
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { hmsApproval?: unknown }).hmsApproval = { previewAttach: { mutate: preview }, writeState: { query: writeState } };
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId={WORK_ITEM} propertyCode="HRCEN" />);
    await chooseCloudBooking();
    fireEvent.click(await screen.findByRole('button', { name: 'Check document and booking' }));
    expect(await screen.findByText('Document available. Booking found. Check they belong together. Upload is not available yet.')).toBeTruthy();
    await act(async () => resolveState({ run: { state: 'dead_letter', lastError: 'upload_unconfirmed', evidence: [] } }));
    expect(await screen.findByText('Check in Infor')).toBeTruthy();
    expect(screen.queryByText('Document available. Booking found. Check they belong together. Upload is not available yet.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Go' })).toBeNull();
  });

  it('also hides the preview when a crashed attach needs an HMS check', async () => {
    let resolveState!: (value: { form: { action: string }; needsCheck: boolean;
      run: { state: string; lastError: string; evidence: { name: string }[] } }) => void;
    const writeState = vi.fn(() => new Promise<Parameters<typeof resolveState>[0]>((done) => { resolveState = done; }));
    const preview = vi.fn(async () => ({ status: 'ready' as const, confirmation: SMITH_ROW.confirmation,
      arrival: SMITH_ROW.arrival, documentName: 'Smith_VCH_1879000.pdf', documentSource: DOCUMENT_SOURCE, revisionSeq: 0 }));
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { hmsApproval?: unknown }).hmsApproval = { previewAttach: { mutate: preview }, writeState: { query: writeState } };
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId={WORK_ITEM} propertyCode="HRCEN" />);
    await chooseCloudBooking();
    fireEvent.click(await screen.findByRole('button', { name: 'Check document and booking' }));
    expect(await screen.findByText('Document available. Booking found. Check they belong together. Upload is not available yet.')).toBeTruthy();
    await act(async () => resolveState({ form: { action: 'attach_document' }, needsCheck: true,
      run: { state: 'dead_letter', lastError: 'lease_lost', evidence: [] } }));
    expect(await screen.findByText('Check in Infor')).toBeTruthy();
    expect(screen.queryByText('Document available. Booking found. Check they belong together. Upload is not available yet.')).toBeNull();
  });

  it('retains an unknown attach warning if the next status read fails', async () => {
    const writeState = vi.fn().mockResolvedValueOnce({ form: { action: 'attach_document' }, needsCheck: true,
      run: { state: 'dead_letter', failureClass: 'UNKNOWN', lastError: 'worker_lost', evidence: [] } })
      .mockRejectedValue(new Error('status unavailable'));
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { hmsApproval?: unknown }).hmsApproval = { writeState: { query: writeState } };
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId={WORK_ITEM} />);
    expect(await screen.findByText('Check in Infor')).toBeTruthy();
    await waitFor(() => expect(writeState.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText('Check in Infor')).toBeTruthy();
  });

  it('keeps the legacy attach action at a different verified property', async () => {
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { quoteWorkflow: Record<string, unknown> }).quoteWorkflow.bindVoucherAttach = { mutate: vi.fn() };
    (trpc as { hmsApproval?: unknown }).hmsApproval = { previewAttach: { mutate: vi.fn() },
      writeState: { query: vi.fn(async () => ({ run: null, needsCheck: false })) } };
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId={WORK_ITEM} propertyCode="HRDAV" writesEnabled />);
    expect(await screen.findByRole('button', { name: 'Attach to HMS booking' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check document and booking' })).toBeNull();
  });

  it('offers no filing action until the active property is verified', async () => {
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { hmsApproval?: unknown }).hmsApproval = { previewAttach: { mutate: vi.fn() } };
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId={WORK_ITEM} propertyCode={null} writesEnabled />);
    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attach to HMS booking' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check document and booking' })).toBeNull();
  });

  it('hides Attach when the voucher file is not a PDF', async () => {
    const { trpc } = fakeTrpc({
      reply: {
        ...VOUCHER,
        file: { id: 'att-1', filename: 'Smith_VCH.png', mimeType: 'image/png', sizeBytes: 100 },
      },
    });
    render(
      <VoucherFindCard
        internetMessageId="abc@host"
        trpc={trpc}
        download={vi.fn()}
        workItemId={WORK_ITEM}
        propertyCode="HRDAV"
        writesEnabled
      />,
    );
    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attach to HMS booking' })).toBeNull();
  });

  it('offers Attach to HMS booking when Find matches exactly one stay and the email has a PDF', async () => {
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    render(
      <VoucherFindCard
        internetMessageId="abc@host"
        trpc={trpc}
        download={vi.fn()}
        workItemId={WORK_ITEM}
        propertyCode="HRDAV"
        writesEnabled
      />,
    );
    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attach to HMS booking' })).toBeTruthy();
  });

  it('pins the status read to the selected email and waits for a safe response before attach', async () => {
    let resolve!: (value: { run: null; needsCheck: boolean }) => void;
    const writeState = vi.fn(() => new Promise<Parameters<typeof resolve>[0]>((done) => { resolve = done; }));
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { hmsApproval?: unknown }).hmsApproval = { writeState: { query: writeState } };
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId={WORK_ITEM} propertyCode="HRDAV" writesEnabled />);
    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(writeState).toHaveBeenCalledWith({ workItemId: WORK_ITEM, internetMessageId: 'abc@host' }, MAILBOX);
    expect(screen.queryByRole('button', { name: 'Attach to HMS booking' })).toBeNull();
    await act(async () => resolve({ run: null, needsCheck: false }));
    expect(await screen.findByRole('button', { name: 'Attach to HMS booking' })).toBeTruthy();
  });

  it('keeps attach unavailable if the status read fails', async () => {
    const writeState = vi.fn(async () => { throw new Error('unavailable'); });
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { hmsApproval?: unknown }).hmsApproval = { writeState: { query: writeState } };
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} workItemId={WORK_ITEM} propertyCode="HRDAV" writesEnabled />);
    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(writeState).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Attach to HMS booking' })).toBeNull();
  });

  it('binds the attach form to the matched stay and the voucher PDF', async () => {
    const bind = vi.fn(async () => ({
      status: 'bound' as const,
      form: {
        confirmation: SMITH_ROW.confirmation,
        pdfSha256: 'a'.repeat(64),
        attachmentId: 'att-1',
      },
    }));
    const otherPdf = { ...PDF, id: 'att-2', filename: 'second.pdf' };
    const { trpc, queueSearchGuest } = fakeTrpc({ reply: { ...VOUCHER, files: [PDF, otherPdf] } });
    const query = vi.fn(async (input: { internetMessageId: string; attachmentId?: string }) => ({
      ...VOUCHER,
      files: [PDF, otherPdf],
      file: input.attachmentId === 'att-2' ? otherPdf : PDF,
      guest: input.attachmentId ? VOUCHER.guest : { lastName: 'Wrong', arrival: '2026-11-12' },
    }));
    trpc.quoteWorkflow.voucherFind.query = query;
    (trpc as { quoteWorkflow: Record<string, unknown> }).quoteWorkflow.bindVoucherAttach = {
      mutate: bind,
    };
    render(
      <VoucherFindCard
        internetMessageId="abc@host"
        trpc={trpc}
        download={vi.fn()}
        workItemId={WORK_ITEM}
        propertyCode="HRDAV"
        writesEnabled
      />,
    );
    await screen.findByLabelText('Document');
    expect(screen.queryByText(/Guest Wrong/)).toBeNull();
    expect(queueSearchGuest).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Document'), { target: { value: 'att-1' } });
    await screen.findByText('John Smith · 57291630-1');
    fireEvent.change(screen.getByLabelText('Document'), { target: { value: 'att-2' } });
    expect(screen.queryByText('John Smith · 57291630-1')).toBeNull();
    await waitFor(() => expect(query).toHaveBeenCalledWith({ internetMessageId: 'abc@host', attachmentId: 'att-2' }, MAILBOX));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach to HMS booking' }));
    await waitFor(() =>
      expect(bind).toHaveBeenCalledWith({
        workItemId: WORK_ITEM,
        confirmation: SMITH_ROW.confirmation,
        arrival: SMITH_ROW.arrival,
        lastName: SMITH_ROW.lastName,
        attachmentId: 'att-2',
      }, MAILBOX),
    );
  });

  it('shows Check in Infor and no success copy when the attach run is upload_unconfirmed', async () => {
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    (trpc as { hmsApproval?: unknown }).hmsApproval = {
      writeState: {
        query: async () => ({
          status: 'needs_you',
          form: { action: 'attach_document' },
          formDigest: 'd'.repeat(64),
          before: null,
          snapshot: null,
          grant: null,
          run: {
            runId: 'run-1',
            state: 'dead_letter',
            failureClass: 'UNKNOWN',
            lastError: 'upload_unconfirmed',
            evidence: [{ eventId: 'ev-1', name: 'after.png', expired: false }],
            reviewed: null,
          },
          needsCheck: true,
        }),
      },
    };
    render(
      <VoucherFindCard
        internetMessageId="abc@host"
        trpc={trpc}
        download={vi.fn()}
        workItemId={WORK_ITEM}
        propertyCode="HRDAV"
        writesEnabled
      />,
    );
    expect(await screen.findByText('Check in Infor')).toBeTruthy();
    expect(screen.queryByText(/attached/i)).toBeNull();
    expect(screen.queryByText(VOUCHER_COPY.saved)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach to HMS booking' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('voucher find bind and search gate', () => {
  it('binds quoteWorkflow.voucherFind off a tRPC client, and null when the route is missing', async () => {
    const { trpc, voucherFind } = fakeTrpc({ reply: VOUCHER });
    const client = voucherFindClientFromTrpc(trpc, 'transport-1');
    expect(client).not.toBeNull();
    await expect(client!.check({ internetMessageId: 'abc@host' })).resolves.toEqual(VOUCHER);
    expect(voucherFind).toHaveBeenCalledWith({ internetMessageId: 'abc@host' }, MAILBOX);
    expect(voucherFindClientFromTrpc({}, 'transport-1')).toBeNull();
    expect(voucherFindClientFromTrpc(trpc, null)).toBeNull();
  });

  it('does not query or show a voucher without mailbox and actor scope', async () => {
    const { trpc, voucherFind } = fakeTrpc({ reply: VOUCHER });
    const { container, rerender } = render(<ScopedVoucherFindCard internetMessageId="abc@host" trpc={trpc} />);
    rerender(<ScopedVoucherFindCard internetMessageId="abc@host" trpc={trpc} transportId="transport-1" />);
    rerender(<ScopedVoucherFindCard internetMessageId="abc@host" trpc={trpc} mailboxScope="user-1:session-1" />);
    expect(container.textContent).toBe('');
    expect(voucherFind).not.toHaveBeenCalled();
  });

  it('pins each voucher read and discards a late reply when mailbox or actor changes', async () => {
    let resolveOld!: (reply: VoucherFindReply) => void;
    const oldReply = new Promise<VoucherFindReply>((resolve) => { resolveOld = resolve; });
    const query = vi.fn().mockReturnValueOnce(oldReply).mockResolvedValue({ status: 'not_voucher' });
    const trpc = { quoteWorkflow: { voucherFind: { query } } };
    const { container, rerender } = render(<ScopedVoucherFindCard internetMessageId="same@host" trpc={trpc}
      transportId="transport-1" mailboxScope="user-1:session-1:transport-1" />);
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    rerender(<ScopedVoucherFindCard internetMessageId="same@host" trpc={trpc}
      transportId="transport-2" mailboxScope="user-2:session-2:transport-2" />);
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    await act(async () => resolveOld(VOUCHER));
    expect(container.textContent).toBe('');
    expect(query).toHaveBeenNthCalledWith(1, { internetMessageId: 'same@host' }, MAILBOX);
    expect(query).toHaveBeenNthCalledWith(2, { internetMessageId: 'same@host' },
      { context: { activeTransportId: 'transport-2' } });
    rerender(<ScopedVoucherFindCard internetMessageId="same@host" trpc={trpc}
      transportId="transport-2" mailboxScope="user-3:session-3:transport-2" />);
    await waitFor(() => expect(query).toHaveBeenCalledTimes(3));
    expect(query).toHaveBeenNthCalledWith(3, { internetMessageId: 'same@host' },
      { context: { activeTransportId: 'transport-2' } });
  });

  it('names only what Luna read, and allows a search only with both a surname and an arrival', () => {
    expect(voucherGuestLine({ lastName: 'Smith', arrival: '2026-11-12' })).toBe(
      `Guest Smith · arriving ${formatStayDate('2026-11-12')}`,
    );
    expect(voucherGuestLine({ lastName: null, arrival: null })).toBeNull();
    expect(canSearchVoucher({ lastName: 'Smith', arrival: '2026-11-12' })).toBe(true);
    expect(canSearchVoucher({ lastName: 'Smith', arrival: null })).toBe(false);
    expect(canSearchVoucher({ lastName: null, arrival: '2026-11-12' })).toBe(false);
    expect(
      canSearchVoucher({
        lastName: 'Smith',
        arrival: '2026-11-12',
        conflicts: { lastNames: ['Smith', 'Jones'], arrivals: [] },
      }),
    ).toBe(false);
  });
});

describe('voucher find card: waiting for the sync', () => {
  it('shows the waiting note while the sync is pending, then checks again when it commits and shows the voucher', async () => {
    const voucherFind = vi
      .fn<(input: { internetMessageId: string }) => Promise<VoucherFindReply>>()
      .mockResolvedValueOnce({ status: 'unsynced' })
      .mockResolvedValue(VOUCHER);
    const trpc = {
      quoteWorkflow: { voucherFind: { query: voucherFind } },
      paneStayLookup: jobRoutesOnly(),
    };
    const { rerender } = render(
      <VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} syncCommitted={5} syncPending />,
    );
    expect(await screen.findByText(VOUCHER_COPY.waitingForSync)).toBeTruthy();
    expect(voucherFind).toHaveBeenCalledTimes(1);
    rerender(
      <VoucherFindCard
        internetMessageId="abc@host"
        trpc={trpc}
        download={vi.fn()}
        syncCommitted={6}
        syncPending={false}
      />,
    );
    expect(await screen.findByRole('button', { name: VOUCHER_COPY.save })).toBeTruthy();
    expect(voucherFind).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(VOUCHER_COPY.waitingForSync)).toBeNull();
  });

  it('shows nothing for an unsynced email when no sync is pending, and does not check again without a commit', async () => {
    const voucherFind = vi.fn(async (_input: { internetMessageId: string }) => ({ status: 'unsynced' as const }));
    const trpc = { quoteWorkflow: { voucherFind: { query: voucherFind } } };
    const { container, rerender } = render(
      <VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} syncCommitted={5} syncPending={false} />,
    );
    await waitFor(() => expect(voucherFind).toHaveBeenCalledTimes(1));
    expect(container.textContent).toBe('');
    rerender(
      <VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} syncCommitted={5} syncPending={false} />,
    );
    expect(voucherFind).toHaveBeenCalledTimes(1);
  });

  it('keeps a check that is still running when the sync commits, and checks once more only when it answers unsynced', async () => {
    let settleFirst: (reply: VoucherFindReply) => void = () => undefined;
    const voucherFind = vi
      .fn<(input: { internetMessageId: string }) => Promise<VoucherFindReply>>()
      .mockImplementationOnce(
        () =>
          new Promise<VoucherFindReply>((resolve) => {
            settleFirst = resolve;
          }),
      )
      .mockResolvedValue(VOUCHER);
    const trpc = {
      quoteWorkflow: { voucherFind: { query: voucherFind } },
      paneStayLookup: jobRoutesOnly(),
    };
    const { rerender } = render(
      <VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} syncCommitted={5} />,
    );
    await waitFor(() => expect(voucherFind).toHaveBeenCalledTimes(1));
    rerender(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} syncCommitted={6} />);
    expect(voucherFind).toHaveBeenCalledTimes(1);
    settleFirst({ status: 'unsynced' });
    expect(await screen.findByRole('button', { name: VOUCHER_COPY.save })).toBeTruthy();
    expect(voucherFind).toHaveBeenCalledTimes(3);
  });

  it('a slow voucher answer is shown even when commits keep advancing while it runs', async () => {
    let settleFirst: (reply: VoucherFindReply) => void = () => undefined;
    const voucherFind = vi
      .fn<(input: { internetMessageId: string }) => Promise<VoucherFindReply>>()
      .mockImplementationOnce(
        () =>
          new Promise<VoucherFindReply>((resolve) => {
            settleFirst = resolve;
          }),
      )
      .mockResolvedValue(VOUCHER);
    const trpc = {
      quoteWorkflow: { voucherFind: { query: voucherFind } },
      paneStayLookup: jobRoutesOnly(),
    };
    const { rerender } = render(
      <VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} syncCommitted={5} />,
    );
    await waitFor(() => expect(voucherFind).toHaveBeenCalledTimes(1));
    for (const committed of [6, 7, 8]) {
      rerender(
        <VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} syncCommitted={committed} />,
      );
    }
    settleFirst(VOUCHER);
    expect(await screen.findByRole('button', { name: VOUCHER_COPY.save })).toBeTruthy();
    expect(voucherFind).toHaveBeenCalledTimes(2);
  });
});

describe('voucher find card: values that disagree', () => {
  it('names the candidate surnames, and offers no search and no missing-name note', async () => {
    const reply: VoucherFindReply = {
      status: 'voucher',
      messageId: 'm1',
      guest: {
        lastName: null,
        arrival: '2026-11-12',
        conflicts: { lastNames: ['Smith', 'Jones'], arrivals: [] },
      },
      file: VOUCHER.file,
    };
    const { trpc, searchGuest } = fakeTrpc({ reply });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    expect(await screen.findByText(`${VOUCHER_COPY.conflictLastNames} Smith, Jones.`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: VOUCHER_COPY.search })).toBeNull();
    expect(screen.queryByText(VOUCHER_COPY.missingGuest)).toBeNull();
    expect(searchGuest).not.toHaveBeenCalled();
  });

  it('names the candidate arrival dates, and offers no search', async () => {
    const reply: VoucherFindReply = {
      status: 'voucher',
      messageId: 'm1',
      guest: {
        lastName: 'Smith',
        arrival: null,
        conflicts: { lastNames: [], arrivals: ['2026-11-12', '2027-06-08'] },
      },
      file: VOUCHER.file,
    };
    const { trpc } = fakeTrpc({ reply });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    expect(
      await screen.findByText(
        `${VOUCHER_COPY.conflictArrivals} ${formatStayDate('2026-11-12')}, ${formatStayDate('2027-06-08')}.`,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: VOUCHER_COPY.search })).toBeNull();
    expect(screen.queryByText(VOUCHER_COPY.missingArrival)).toBeNull();
  });

  it('lists nothing when the voucher agrees with itself', () => {
    expect(voucherConflictLines({ lastName: 'Smith', arrival: '2026-11-12' })).toEqual([]);
    expect(
      voucherConflictLines({ lastName: null, arrival: null, conflicts: { lastNames: ['Smith', 'Jones'], arrivals: [] } }),
    ).toEqual([`${VOUCHER_COPY.conflictLastNames} Smith, Jones.`]);
  });
});

describe('voucher find card: a voucher PDF that could not be read', () => {
  it('adds no line of its own, since the quote panel names the unread file, and keeps the search', async () => {
    const { trpc } = fakeTrpc({ reply: { ...VOUCHER, unreadPdfs: 1 } });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    expect(await screen.findByRole('button', { name: VOUCHER_COPY.save })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the missing surname note again once every voucher PDF was read', async () => {
    const { trpc } = fakeTrpc({
      reply: { ...VOUCHER, guest: { lastName: null, arrival: '2026-11-12' }, unreadPdfs: 0 },
    });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    expect(await screen.findByText(VOUCHER_COPY.missingGuest)).toBeTruthy();
  });

  it('keeps the missing surname note out while a voucher PDF is unread, and offers no search without a surname', async () => {
    const { trpc } = fakeTrpc({
      reply: { ...VOUCHER, guest: { lastName: null, arrival: '2026-11-12' }, unreadPdfs: 2 },
    });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    expect(await screen.findByText(VOUCHER_COPY.caption)).toBeTruthy();
    expect(screen.queryByText(VOUCHER_COPY.missingGuest)).toBeNull();
    expect(screen.queryByRole('button', { name: VOUCHER_COPY.search })).toBeNull();
  });

  it('keeps a conflict line while a voucher PDF is unread, because it comes from text that was read', async () => {
    const { trpc } = fakeTrpc({
      reply: {
        ...VOUCHER,
        guest: { lastName: null, arrival: null, conflicts: { lastNames: ['Smith', 'Jones'], arrivals: [] } },
        unreadPdfs: 1,
      },
    });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    expect(await screen.findByText(`${VOUCHER_COPY.conflictLastNames} Smith, Jones.`)).toBeTruthy();
    expect(screen.queryByText(VOUCHER_COPY.missingGuest)).toBeNull();
  });
});

describe('voucher find card: guest details are marked for the preview gate (H6b)', () => {
  it('marks the guest line, the file name and each HMS row with data-pii', async () => {
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    const { container } = render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    await screen.findByText('John Smith · 57291630-1');
    expect(screen.getByText(`Guest Smith · arriving ${formatStayDate('2026-11-12')}`).hasAttribute('data-pii')).toBe(true);
    expect(unmaskedPii(container, ['Smith', 'John', '57291630-1'])).toEqual([]);
  });

  it('marks the conflicting surnames and a search with no match', async () => {
    const reply: VoucherFindReply = {
      status: 'voucher',
      messageId: 'm1',
      guest: { lastName: null, arrival: '2026-11-12', conflicts: { lastNames: ['Smith', 'Jones'], arrivals: [] } },
      file: VOUCHER.file,
    };
    const conflict = render(<VoucherFindCard internetMessageId="abc@host" trpc={fakeTrpc({ reply }).trpc} download={vi.fn()} />);
    await screen.findByText(`${VOUCHER_COPY.conflictLastNames} Smith, Jones.`);
    expect(unmaskedPii(conflict.container, ['Smith', 'Jones'])).toEqual([]);
    conflict.unmount();

    const { trpc } = fakeTrpc({ reply: VOUCHER, search: { outcome: 'ok', rows: [], screenshots: [], runId: null } });
    const { container } = render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    await screen.findByText(noSearchMatchCopy('Smith', '2026-11-12'));
    expect(unmaskedPii(container, ['Smith'])).toEqual([]);
  });
});
