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
  type GuestSearchInput,
  type GuestSearchReply,
  type HmsJobView,
} from '../lib/quote-workflow/amend-find';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VoucherFindCard } from '../components/quote-workflow/voucher-find-card';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unmaskedPii } from './helpers/pii-marks';

let restoreClipboard: () => void = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  restoreClipboard();
  restoreClipboard = () => {};
});

const AS_OF = '2026-10-09T08:05:00.000Z';

const VOUCHER: VoucherFindReply = {
  status: 'voucher',
  messageId: 'm1',
  threadId: 'thread-1',
  guest: { lastName: 'Smith', arrival: '2026-11-12' },
  file: {
    id: 'att-1',
    filename: 'Smith_VCH_1879000.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 100,
  },
};

const SMITH_ROW = {
  confirmation: '57291630-1',
  lastName: 'Smith',
  firstName: 'John',
  status: 'Reserved',
  arrival: '2026-11-12',
  departure: '2026-11-14',
};

type JobStatusQuery = (input: { threadId: string; kind: 'find' | 'search_guest' | 'availability'; lastName?: string; arrival?: string; departure?: string | null }) => Promise<HmsJobView | null>;

// The trpc client the pane passes in: the voucher check and the guest-name search job routes, and nothing else.
// Each queued search runs its mock and is stored as a finished job, so jobStatus answers on the first poll.
function fakeTrpc(options: {
  reply: VoucherFindReply;
  search?: GuestSearchReply;
  resumed?: HmsJobView | null;
  status?: JobStatusQuery;
  /** The server's job queue is off: queueSearchGuest queues nothing and returns no run id. */
  queueOff?: boolean;
}) {
  const voucherFind = vi.fn(async (_input: { internetMessageId: string }) => options.reply);
  const searchGuest = vi.fn(
    async (_input: { lastName: string; arrival: string; departure?: string }) =>
      options.search ?? { outcome: 'ok', rows: [SMITH_ROW], screenshots: [], runId: null },
  );
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
  return {
    trpc: {
      quoteWorkflow: { voucherFind: { query: voucherFind } },
      paneStayLookup: {
        queueFind: { mutate: vi.fn() },
        queueSearchGuest: { mutate: queueSearchGuest },
        searchGuest: { mutate: searchGuest },
        jobStatus: {
          query: async (
            input:
              | { runId: string }
              | {
                  threadId: string;
                  kind: 'find' | 'search_guest' | 'availability';
                  lastName?: string;
                  arrival?: string;
                  departure?: string | null;
                },
          ) => {
            if ('threadId' in input && options.status) return options.status(input);
            if ('runId' in input) return jobs.get(input.runId) ?? null;
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
    searchGuest,
    queueSearchGuest,
  };
}

// The job routes alone, for the sync cases that never run a search.
const jobRoutesOnly = () => fakeTrpc({ reply: VOUCHER }).trpc.paneStayLookup;

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
    expect(screen.getByRole('button', { name: 'Copy for HMS' })).toBeTruthy();
    const saveAndMatch = screen.getByTestId('voucher-save-and-match');
    expect(saveAndMatch.contains(screen.getByRole('button', { name: VOUCHER_COPY.save }))).toBe(true);
    expect(saveAndMatch.contains(screen.getByRole('button', { name: 'Copy for HMS' }))).toBe(true);
    expect(searchGuest).toHaveBeenCalledWith({ lastName: 'Smith', arrival: '2026-11-12' });
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
    expect(searchGuest).toHaveBeenCalledWith({ lastName: 'Smith', arrival: '2026-11-12' });
    expect(queueSearchGuest).toHaveBeenCalledWith({
      threadId: 'thread-1',
      lastName: 'Smith',
      arrival: '2026-11-12',
      autoStart: true,
    });
    expect(screen.queryByRole('button', { name: VOUCHER_COPY.search })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy for HMS' })).toBeTruthy();
  });

  it('with the job queue off, opening the card runs no HMS search and the Find button runs one on click', async () => {
    const { trpc, searchGuest, queueSearchGuest } = fakeTrpc({ reply: VOUCHER, queueOff: true });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    await waitFor(() => expect(queueSearchGuest).toHaveBeenCalledWith(expect.objectContaining({ autoStart: true })));
    expect(searchGuest).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: VOUCHER_COPY.search }));
    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(searchGuest).toHaveBeenCalledTimes(1);
    expect(searchGuest).toHaveBeenCalledWith({ lastName: 'Smith', arrival: '2026-11-12' });
  });

  it('hydrates a matching prefetched result on open and never queues another lookup', async () => {
    const prefetched: HmsJobView = {
      runId: 'prefetch-1',
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

  it('keeps Find hidden until a slow read-back settles, then shows the existing result', async () => {
    const prefetched: HmsJobView = {
      runId: 'prefetch-slow',
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
    expect(screen.getAllByRole('button', { name: 'Copy for HMS' })).toHaveLength(2);
    expect(status).toHaveBeenCalledWith({
      threadId: 'thread-1',
      kind: 'search_guest',
      lastName: 'Smith',
      arrival: '2026-11-12',
      departure: null,
    });
    expect(queueSearchGuest).toHaveBeenCalledWith({
      threadId: 'thread-1',
      lastName: 'Smith',
      arrival: '2026-11-12',
      autoStart: true,
    });
    expect(searchGuest).toHaveBeenCalledWith({ lastName: 'Smith', arrival: '2026-11-12' });
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

  it('copies the HMS landing page with the matched confirmation, surname and arrival in one action', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Copy for HMS' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${landing}\nConfirmation: 57291630-1\nGuest surname: Smith\nArrival: 2026-11-12`,
      ),
    );
    expect(await screen.findByRole('button', { name: 'Copied for HMS' })).toBeTruthy();
  });

  it('shows multiple matches without choosing one for the attachment row', async () => {
    const secondRow = { ...SMITH_ROW, confirmation: '57291630-2', firstName: 'James' };
    const { trpc } = fakeTrpc({
      reply: VOUCHER,
      search: { outcome: 'ok', rows: [SMITH_ROW, secondRow], screenshots: [], runId: null },
    });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);

    expect(await screen.findByText('John Smith · 57291630-1')).toBeTruthy();
    expect(screen.getByText('James Smith · 57291630-2')).toBeTruthy();
    expect(screen.getByText(VOUCHER_COPY.pickRow)).toBeTruthy();
    expect(screen.queryByTestId('voucher-matched-booking')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Copy for HMS' })).toHaveLength(2);
  });

  it('reads a booking number only from HMS rows, never from the voucher text', async () => {
    const reply: VoucherFindReply = {
      ...VOUCHER,
      guest: { lastName: 'Smith', arrival: '2026-11-12' },
    };
    const { trpc, searchGuest } = fakeTrpc({
      reply,
      search: { outcome: 'ok', rows: [], screenshots: [], runId: null },
    });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(noSearchMatchCopy('Smith', '2026-11-12'))).toBeTruthy(),
    );
    // The voucher reference 1879000 in the file name is not a booking, so no copy action appears.
    expect(screen.queryByRole('button', { name: 'Copy confirmation' })).toBeNull();
    expect(searchGuest).toHaveBeenCalledTimes(1);
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
      lastName: 'Smith',
      arrival: '2026-11-12',
      autoStart: true,
    };
    expect(queueSearchGuest).toHaveBeenNthCalledWith(1, idempotentAutoStart);
    expect(queueSearchGuest).toHaveBeenNthCalledWith(2, idempotentAutoStart);
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
    const { trpc } = fakeTrpc({ reply: { ...VOUCHER, file: null } });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    expect(await screen.findByText(VOUCHER_COPY.noFile)).toBeTruthy();
    expect(screen.queryByRole('button', { name: VOUCHER_COPY.save })).toBeNull();
  });
});

describe('voucher find bind and search gate', () => {
  it('binds quoteWorkflow.voucherFind off a tRPC client, and null when the route is missing', async () => {
    const { trpc, voucherFind } = fakeTrpc({ reply: VOUCHER });
    const client = voucherFindClientFromTrpc(trpc);
    expect(client).not.toBeNull();
    await expect(client!.check({ internetMessageId: 'abc@host' })).resolves.toEqual(VOUCHER);
    expect(voucherFind).toHaveBeenCalledWith({ internetMessageId: 'abc@host' });
    expect(voucherFindClientFromTrpc({})).toBeNull();
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
    expect(voucherFind).toHaveBeenCalledTimes(2);
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
    expect(voucherFind).toHaveBeenCalledTimes(2);
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
      .mockResolvedValue({ status: 'not_voucher' });
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
    expect(voucherFind).toHaveBeenCalledTimes(1);
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
