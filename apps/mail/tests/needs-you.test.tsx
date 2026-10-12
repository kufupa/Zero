/**
 * @vitest-environment happy-dom
 */
import {
  NeedsYouScreen,
  NeedsYouWebControl,
  useNeedsYou,
} from '../components/nava-pane/screens/needs-you';
import {
  HMS_JOB_MAX_MISSES,
  HMS_JOB_POLL_MS,
  type HmsJobView,
} from '../lib/quote-workflow/amend-find';
import type { NeedsYouRow, RunNeedsYouItemResult } from '../lib/quote-workflow/backend-bind';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneBridge } from '../lib/workstation/pane-bridge-types';
import { NavaPane } from '../components/nava-pane/nava-pane';
import { trpcClient } from '../providers/query-provider';
import { unmaskedPii } from './helpers/pii-marks';

const {
  listQuery,
  dismissMutate,
  runNeedsYouItemMutate,
  batchStatusQuery,
  jobStatusQuery,
  pingMutate,
  silent,
} = vi.hoisted(() => {
  // A route this file does not exercise never answers, so the pane waits on it instead of failing.
  const silent = (): unknown =>
    new Proxy(() => new Promise<never>(() => {}), { get: () => silent() });
  return {
    listQuery: vi.fn(),
    dismissMutate: vi.fn(),
    runNeedsYouItemMutate: vi.fn(),
    batchStatusQuery: vi.fn(),
    jobStatusQuery: vi.fn(),
    pingMutate: vi.fn().mockResolvedValue({ status: 'ok', serverTime: '2026-10-09T12:00:00Z' }),
    silent,
  };
});

// Only the work-items list and dismiss routes, the one-row HMS run/status, plus the pane ping.
vi.mock('../providers/query-provider', () => {
  const routes: Record<PropertyKey, unknown> = {
    workstation: { ping: { mutate: pingMutate } },
    get workItems() {
      return { list: { query: listQuery }, dismiss: { mutate: dismissMutate } };
    },
    paneStayLookup: {
      runNeedsYouItem: { mutate: runNeedsYouItemMutate },
      batchStatus: { query: batchStatusQuery },
      jobStatus: { query: jobStatusQuery },
    },
  };
  return {
    trpcClient: new Proxy(routes, {
      get: (target, key) => (key in target ? Reflect.get(target, key) : silent()),
    }),
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../lib/workstation/pane-release-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workstation/pane-release-watch')>()),
  reloadPane: vi.fn(),
}));

vi.mock('../lib/auth-client', () => ({
  useSession: () => ({
    data: {
      user: { id: 'staff-1', email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' },
      session: { id: 's-1' },
    },
    isLoading: false,
  }),
  signIn: { email: vi.fn() },
}));

vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: { id: 'transport-1', email: 'ropperman@legacyhotels.co.za' },
    isLoading: false,
  }),
}));

vi.mock('@/hooks/use-pilot-capabilities', () => ({
  usePilotCapabilities: () => ({ paneSave: false }),
}));

function row(overrides: Partial<NeedsYouRow> & Pick<NeedsYouRow, 'id'>): NeedsYouRow {
  return {
    kind: 'quote',
    status: 'needs_you',
    chip: 'needs_you',
    threadId: `thread-${overrides.id}`,
    sender: 'david@example.com',
    subject: 'Rooms request',
    receivedAt: new Date('2026-10-05T09:00:00Z'),
    hms: null,
    hmsDisabledReason: null,
    ...overrides,
  };
}

const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OLD_RUN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function hmsSnapshot(
  status: NonNullable<NeedsYouRow['hms']>['status'],
  summary: string | null = null,
): NonNullable<NeedsYouRow['hms']> {
  return {
    status,
    asOf: '2026-10-10T12:00:00.000Z',
    runId: RUN_ID,
    summary,
  };
}

function foundRunResult(workItemId: string, summary = 'found'): NonNullable<RunNeedsYouItemResult> {
  return {
    batchId: 'batch-fixture-1',
    status: 'done',
    summary: {
      total: 1,
      queued: 0,
      running: 0,
      retrying: 0,
      done: 1,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      reused: 0,
    },
    items: [
      {
        itemIndex: 0,
        workItemId,
        status: 'done',
        reason: null,
        runId: RUN_ID,
        request: null,
        job: {
          runId: RUN_ID,
          request: null,
          prefetch: false,
          status: 'done',
          position: null,
          attempts: 1,
          failureClass: null,
          asOf: '2026-10-10T12:00:00.000Z',
          result: { outcome: summary },
        },
      },
    ],
  };
}

function queuedRunResult(workItemId: string): NonNullable<RunNeedsYouItemResult> {
  const result = foundRunResult(workItemId);
  result.status = 'queued';
  result.summary.done = 0;
  result.summary.queued = 1;
  result.items[0]!.status = 'queued';
  Object.assign(result.items[0]!.job!, { status: 'queued', asOf: null, result: null });
  return result;
}

function foundJob(): HmsJobView {
  return foundRunResult('wi-2').items[0]!.job!;
}

const TWO_OPEN = [
  row({ id: 'wi-1', subject: 'Rooms request' }),
  row({
    id: 'wi-2',
    subject: 'Confirm booking',
    kind: 'booking',
    status: 'review',
    chip: 'review',
    sender: 'bookings@agency.example',
  }),
];

/** The screen with its list hook, as the pane and the webmail dialog mount it. */
function Harness({
  host,
  client,
  onOpenThread,
}: {
  host: 'web' | 'outlook';
  client?: unknown;
  onOpenThread?: (threadId: string) => void;
}) {
  const list = useNeedsYou(
    client ?? {
      workItems: { list: { query: listQuery }, dismiss: { mutate: dismissMutate } },
      paneStayLookup: {
        runNeedsYouItem: { mutate: runNeedsYouItemMutate },
        batchStatus: { query: batchStatusQuery },
        jobStatus: { query: jobStatusQuery },
      },
    },
  );
  return <NeedsYouScreen list={list} host={host} onOpenThread={onOpenThread} />;
}

/** The screen with a button that starts a reload, so a test can hold one in flight across a dismiss. */
function ReloadingHarness() {
  const list = useNeedsYou({
    workItems: { list: { query: listQuery }, dismiss: { mutate: dismissMutate } },
    paneStayLookup: {
      runNeedsYouItem: { mutate: runNeedsYouItemMutate },
      jobStatus: { query: jobStatusQuery },
    },
  });
  return (
    <>
      <button type="button" onClick={list.reload}>
        Reload now
      </button>
      <NeedsYouScreen list={list} host="web" onOpenThread={() => {}} />
    </>
  );
}

// Same bridge values as the fake bridge in nava-pane-render.test.tsx, with no email selected.
const v4Capabilities = {
  bridgeProtocolVersion: 4,
  addinVersion: '1.0.12',
  outlookVersion: '16.0',
  runtime: 'Classic Outlook for Windows',
  newOutlookSupported: false,
  interactiveProfileRequired: true,
  maxPageSize: 200,
  maxFolderDepth: 64,
  maxFolderCount: 5000,
  maxFolderSnapshotItems: 5000,
  supportedActions: [
    'GET_CAPABILITIES',
    'GET_ACTIVE_EMAIL',
    'CREATE_REPLY_DRAFT',
    'ADD_ATTACHMENT_TO_DRAFT',
  ],
};

const fakeBridge = {
  isConnected: true,
  workstationInfo: { addinVersion: '1.0.12', bridgeProtocolVersion: 4, paired: true },
  capabilities: v4Capabilities,
  supportsAction: (action: string) => v4Capabilities.supportedActions.includes(action),
  activeEmail: null,
  sendCommand: vi.fn(async () => null),
  pairDevice: vi.fn(async () => {}),
} as unknown as PaneBridge;

beforeEach(() => {
  localStorage.setItem('nava_onboarding_completed', 'true');
  listQuery.mockReset();
  listQuery.mockResolvedValue(TWO_OPEN);
  dismissMutate.mockReset();
  dismissMutate.mockResolvedValue({ status: 'dismissed' });
  runNeedsYouItemMutate.mockReset();
  runNeedsYouItemMutate.mockResolvedValue(foundRunResult('wi-2'));
  batchStatusQuery.mockReset();
  batchStatusQuery.mockResolvedValue(null);
  jobStatusQuery.mockReset();
  jobStatusQuery.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  cleanup();
});

describe('Needs-you list', () => {
  it('shows each open item with its kind, sender, subject, received time and chip, in the order the list sends', async () => {
    listQuery.mockResolvedValue([
      row({ id: 'wi-1', chip: 'needs_you', subject: 'Rooms request' }),
      row({
        id: 'wi-2',
        chip: 'review',
        status: 'review',
        kind: 'booking',
        sender: 'bookings@agency.example',
        subject: 'Confirm Labtest booking',
        receivedAt: new Date('2026-10-06T10:30:00Z'),
      }),
      row({ id: 'wi-3', chip: 'queued', kind: 'amendment', subject: 'Move my dates' }),
      row({ id: 'wi-4', chip: 'in_hms', kind: 'voucher_pop', subject: 'Voucher for the group' }),
      row({ id: 'wi-5', kind: 'cancellation', subject: 'Cancel this booking' }),
      row({ id: 'wi-6', kind: 'other', subject: 'Other request' }),
    ]);
    render(<Harness host="web" onOpenThread={() => {}} />);

    expect(await screen.findByRole('heading', { name: 'Needs you (6)' })).toBeDefined();
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.querySelector('[data-chip]')?.textContent)).toEqual([
      'Needs you',
      'Review',
      'Queued',
      'In HMS',
      'Needs you',
      'Needs you',
    ]);
    expect(items[1]!.textContent).toContain('Booking');
    expect(items[1]!.textContent).toContain('bookings@agency.example');
    expect(items[1]!.textContent).toContain('Confirm Labtest booking');
    expect(items[0]!.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-10-05T09:00:00.000Z',
    );
    expect(items[2]!.textContent).toContain('Amendment');
    expect(items[3]!.textContent).toContain('Voucher or POP');
    expect(items[0]!.querySelector('button[aria-label^="Run HMS"]')).toBeNull();
    expect(items[4]!.textContent).toContain('Cancellation');
    expect(items[5]!.textContent).toContain('Other');
    expect(
      items.slice(1, 5).every((item) => item.querySelector('button[aria-label^="Run HMS"]')),
    ).toBe(true);
    expect(items[5]!.querySelector('button[aria-label^="Run HMS"]')).toBeNull();
  });

  it.each(['web', 'outlook'] as const)(
    '%s runs HMS for one eligible row and keeps the existing chip unchanged',
    async (host) => {
      render(<Harness host={host} />);

      fireEvent.click(await screen.findByRole('button', { name: 'Run HMS Confirm booking' }));

      expect(runNeedsYouItemMutate).toHaveBeenCalledTimes(1);
      expect(runNeedsYouItemMutate).toHaveBeenCalledWith({ workItemId: 'wi-2' });
      const booking = screen.getByRole('button', { name: 'Run HMS Confirm booking' }).closest('li');
      expect(booking?.querySelector('[data-chip]')?.textContent).toBe('Review');
      expect(await screen.findByText('In HMS: found')).toBeDefined();
      expect(
        screen.getByRole('button', { name: 'Run HMS Confirm booking' }).hasAttribute('disabled'),
      ).toBe(false);
    },
  );

  it('shows done summaries as found or not found', async () => {
    listQuery.mockResolvedValue([
      row({ id: 'wi-found', kind: 'booking', hms: hmsSnapshot('done', 'found') }),
      row({ id: 'wi-missing', kind: 'amendment', hms: hmsSnapshot('done', 'not found') }),
    ]);
    render(<Harness host="web" />);

    expect(await screen.findByText('In HMS: found')).toBeDefined();
    expect(screen.getByText('In HMS: not found')).toBeDefined();
  });

  it('polls a queued one-item run by durable runId and updates its row when HMS finishes', async () => {
    const queued: NonNullable<RunNeedsYouItemResult> = {
      batchId: 'batch-fixture-1',
      status: 'queued',
      summary: {
        total: 1,
        queued: 1,
        running: 0,
        retrying: 0,
        done: 0,
        failed: 0,
        cancelled: 0,
        skipped: 0,
        reused: 0,
      },
      items: [
        {
          itemIndex: 0,
          workItemId: 'wi-2',
          status: 'queued',
          reason: null,
          runId: RUN_ID,
          request: null,
          job: {
            runId: RUN_ID,
            request: null,
            prefetch: false,
            status: 'queued',
            position: null,
            attempts: 0,
            failureClass: null,
            asOf: null,
            result: null,
          },
        },
      ],
    };
    runNeedsYouItemMutate.mockResolvedValueOnce(queued);
    jobStatusQuery.mockResolvedValueOnce(foundJob());
    render(<Harness host="web" />);
    const run = await screen.findByRole('button', { name: 'Run HMS Confirm booking' });
    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(run);
      await Promise.resolve();
    });

    expect(screen.getByText('Checking HMS… about 2 min')).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HMS_JOB_POLL_MS);
    });
    expect(screen.getByText('In HMS: found')).toBeDefined();
    expect(jobStatusQuery).toHaveBeenCalledWith({ runId: RUN_ID });
    expect(batchStatusQuery).not.toHaveBeenCalled();
  });

  it.each(['queued', 'running', 'retrying'] as const)(
    'resumes a remounted %s row by durable runId',
    async (status) => {
      listQuery.mockResolvedValue([row({ id: 'wi-2', kind: 'booking', hms: hmsSnapshot(status) })]);
      const first = render(<Harness host="web" />);
      await screen.findByText('Checking HMS… about 2 min');
      first.unmount();
      jobStatusQuery.mockResolvedValue(foundJob());
      vi.useFakeTimers();
      await act(async () => {
        render(<Harness host="web" />);
      });
      expect(screen.getByText('Checking HMS… about 2 min')).toBeDefined();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HMS_JOB_POLL_MS);
      });
      expect(screen.getByText('In HMS: found')).toBeDefined();
      expect(jobStatusQuery).toHaveBeenCalledWith({ runId: RUN_ID });
      expect(runNeedsYouItemMutate).not.toHaveBeenCalled();
      expect(
        (screen.getByRole('button', { name: 'Run HMS Rooms request' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      const polls = jobStatusQuery.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HMS_JOB_POLL_MS * 2);
      });
      expect(jobStatusQuery).toHaveBeenCalledTimes(polls);
    },
  );

  it('keeps the new local run when an older list response arrives after enqueue and after completion', async () => {
    let resolveList!: (rows: NeedsYouRow[]) => void;
    let resolveRun!: (result: RunNeedsYouItemResult) => void;
    listQuery.mockResolvedValueOnce(TWO_OPEN).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );
    runNeedsYouItemMutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );
    jobStatusQuery.mockResolvedValue(foundJob());
    render(<ReloadingHarness />);
    const button = await screen.findByRole('button', { name: 'Run HMS Confirm booking' });
    fireEvent.click(screen.getByRole('button', { name: 'Reload now' }));
    fireEvent.click(button);
    vi.useFakeTimers();
    await act(async () => {
      resolveRun(queuedRunResult('wi-2'));
    });
    await act(async () => {
      resolveList([
        TWO_OPEN[0]!,
        row({ ...TWO_OPEN[1]!, hms: { ...hmsSnapshot('done', 'not found'), runId: OLD_RUN_ID } }),
      ]);
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Checking HMS… about 2 min')).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HMS_JOB_POLL_MS);
    });
    expect(screen.getByText('In HMS: found')).toBeDefined();
    listQuery.mockResolvedValue([TWO_OPEN[0]!, row({ ...TWO_OPEN[1]!, hms: null })]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reload now' }));
    });
    expect(screen.getByText('In HMS: found')).toBeDefined();
  });

  it('ignores an older active snapshot while the local enqueue is pending', async () => {
    let resolveRun!: (result: RunNeedsYouItemResult) => void;
    runNeedsYouItemMutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );
    listQuery
      .mockResolvedValueOnce(TWO_OPEN)
      .mockResolvedValueOnce([
        TWO_OPEN[0]!,
        row({ ...TWO_OPEN[1]!, hms: { ...hmsSnapshot('running'), runId: OLD_RUN_ID } }),
      ]);
    render(<ReloadingHarness />);
    const button = await screen.findByRole('button', { name: 'Run HMS Confirm booking' });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(screen.getByRole('button', { name: 'Reload now' }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HMS_JOB_POLL_MS);
    });
    expect(jobStatusQuery).not.toHaveBeenCalled();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      resolveRun(queuedRunResult('wi-2'));
    });
    jobStatusQuery.mockResolvedValue(foundJob());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HMS_JOB_POLL_MS);
    });
    expect(jobStatusQuery).toHaveBeenCalledWith({ runId: RUN_ID });
    expect(screen.getByText('In HMS: found')).toBeDefined();
  });

  it('shows queue-off null as unavailable and prevents futile retries for this mount', async () => {
    runNeedsYouItemMutate.mockResolvedValueOnce(null);
    render(<Harness host="web" />);
    const button = await screen.findByRole('button', { name: 'Run HMS Confirm booking' });
    fireEvent.click(button);
    expect(await screen.findByText('HMS checks are unavailable in this session.')).toBeDefined();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Couldn't queue an HMS check. Try again.")).toBeNull();
    fireEvent.click(button);
    expect(runNeedsYouItemMutate).toHaveBeenCalledTimes(1);
  });

  it.each(['null', 'error'] as const)(
    'stops after bounded %s status misses with a recoverable failed state',
    async (reply) => {
      runNeedsYouItemMutate.mockResolvedValueOnce(queuedRunResult('wi-2'));
      if (reply === 'error') jobStatusQuery.mockRejectedValue(new Error('offline'));
      render(<Harness host="web" />);
      const button = await screen.findByRole('button', { name: 'Run HMS Confirm booking' });
      vi.useFakeTimers();
      await act(async () => {
        fireEvent.click(button);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HMS_JOB_POLL_MS * HMS_JOB_MAX_MISSES);
      });
      expect(screen.getByText('HMS check failed.')).toBeDefined();
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(jobStatusQuery).toHaveBeenCalledTimes(HMS_JOB_MAX_MISSES);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HMS_JOB_POLL_MS * 2);
      });
      expect(jobStatusQuery).toHaveBeenCalledTimes(HMS_JOB_MAX_MISSES);
      runNeedsYouItemMutate.mockResolvedValueOnce(foundRunResult('wi-2'));
      await act(async () => {
        fireEvent.click(button);
      });
      expect(screen.getByText('In HMS: found')).toBeDefined();
    },
  );

  it('resets consecutive status misses after a successful active reply', async () => {
    runNeedsYouItemMutate.mockResolvedValueOnce(queuedRunResult('wi-2'));
    for (let i = 0; i < HMS_JOB_MAX_MISSES - 1; i++) jobStatusQuery.mockResolvedValueOnce(null);
    jobStatusQuery.mockResolvedValueOnce(queuedRunResult('wi-2').items[0]!.job);
    render(<Harness host="web" />);
    const button = await screen.findByRole('button', { name: 'Run HMS Confirm booking' });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HMS_JOB_POLL_MS * (HMS_JOB_MAX_MISSES * 2 - 1));
    });
    expect(screen.getByText('Checking HMS… about 2 min')).toBeDefined();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HMS_JOB_POLL_MS);
    });
    expect(screen.getByText('HMS check failed.')).toBeDefined();
  });

  it('drops late status responses and clears polling when a row unmounts', async () => {
    let resolveStatus!: (view: HmsJobView) => void;
    jobStatusQuery.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    runNeedsYouItemMutate.mockResolvedValueOnce(queuedRunResult('wi-2'));
    const view = render(<Harness host="web" />);
    const button = await screen.findByRole('button', { name: 'Run HMS Confirm booking' });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HMS_JOB_POLL_MS);
    });
    expect(jobStatusQuery).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {
      resolveStatus(foundJob());
      await vi.advanceTimersByTimeAsync(HMS_JOB_POLL_MS * 2);
    });
    expect(jobStatusQuery).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('In HMS: found')).toBeNull();
  });

  it('shows active job states as checking and disables a second run', async () => {
    listQuery.mockResolvedValue([
      row({ id: 'wi-queued', kind: 'booking', hms: hmsSnapshot('queued') }),
      row({ id: 'wi-running', kind: 'amendment', hms: hmsSnapshot('running') }),
      row({ id: 'wi-retrying', kind: 'cancellation', hms: hmsSnapshot('retrying') }),
    ]);
    render(<Harness host="web" />);

    expect((await screen.findAllByText('Checking HMS… about 2 min')).length).toBe(3);
    expect(
      screen
        .getAllByRole('button', { name: /^Run HMS/ })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
  });

  it('disables an insufficient-data row with a visible reason', async () => {
    listQuery.mockResolvedValue([
      row({
        id: 'wi-no-data',
        kind: 'booking',
        hms: hmsSnapshot('insufficient_data'),
        hmsDisabledReason: 'insufficient_data',
      }),
    ]);
    render(<Harness host="web" />);

    const run = await screen.findByRole('button', { name: 'Run HMS Rooms request' });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Not enough details to check HMS.')).toBeDefined();
  });

  it('uses current row details instead of an old insufficient-data result to disable the check', async () => {
    listQuery.mockResolvedValue([
      row({
        id: 'wi-now-has-data',
        kind: 'booking',
        hms: hmsSnapshot('insufficient_data'),
        hmsDisabledReason: null,
      }),
    ]);
    render(<Harness host="web" />);

    const run = await screen.findByRole('button', { name: 'Run HMS Rooms request' });
    expect((run as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Not enough details to check HMS.')).toBeNull();
  });

  it('a guest search that ends ambiguous_capped reads as found when the check finishes, as on reopen', async () => {
    runNeedsYouItemMutate.mockResolvedValueOnce(foundRunResult('wi-2', 'ambiguous_capped'));
    render(<Harness host="web" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Run HMS Confirm booking' }));

    expect(await screen.findByText('In HMS: found')).toBeDefined();
    expect(screen.queryByText('In HMS: checked')).toBeNull();
  });

  it('a list read with the marker run re-enables Run HMS once the row details are complete', async () => {
    listQuery.mockResolvedValueOnce(TWO_OPEN).mockResolvedValueOnce([
      TWO_OPEN[0]!,
      {
        ...TWO_OPEN[1]!,
        hms: { status: 'insufficient_data', asOf: null, runId: RUN_ID, summary: null },
        hmsDisabledReason: null,
      },
    ]);
    runNeedsYouItemMutate.mockResolvedValueOnce({
      batchId: 'batch-fixture-3',
      status: 'done',
      summary: {
        total: 1,
        queued: 0,
        running: 0,
        retrying: 0,
        done: 0,
        failed: 0,
        cancelled: 0,
        skipped: 1,
        reused: 0,
      },
      items: [
        {
          itemIndex: 0,
          workItemId: 'wi-2',
          status: 'skipped',
          reason: 'insufficient_data',
          runId: null,
          request: null,
          job: null,
        },
      ],
    });
    render(<ReloadingHarness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run HMS Confirm booking' }));
    expect(await screen.findByText('Not enough details to check HMS.')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Reload now' }));

    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Run HMS Confirm booking' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  it('updates a skipped insufficient-data response into a visible disabled state', async () => {
    runNeedsYouItemMutate.mockResolvedValueOnce({
      batchId: 'batch-fixture-2',
      status: 'done',
      summary: {
        total: 1,
        queued: 0,
        running: 0,
        retrying: 0,
        done: 0,
        failed: 0,
        cancelled: 0,
        skipped: 1,
        reused: 0,
      },
      items: [
        {
          itemIndex: 0,
          workItemId: 'wi-2',
          status: 'skipped',
          reason: 'insufficient_data',
          runId: null,
          request: null,
          job: null,
        },
      ],
    });
    render(<Harness host="web" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Run HMS Confirm booking' }));

    expect(await screen.findByText('Not enough details to check HMS.')).toBeDefined();
    expect(
      (screen.getByRole('button', { name: 'Run HMS Confirm booking' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('keeps stale and failed rows eligible for a fresh check', async () => {
    listQuery.mockResolvedValue([
      row({ id: 'wi-stale', kind: 'booking', hms: hmsSnapshot('stale') }),
      row({ id: 'wi-failed', kind: 'amendment', hms: hmsSnapshot('failed') }),
    ]);
    render(<Harness host="web" />);

    expect(await screen.findByText('HMS result is stale.')).toBeDefined();
    expect(screen.getByText('HMS check failed.')).toBeDefined();
    expect(
      screen
        .getAllByRole('button', { name: /^Run HMS/ })
        .every((button) => !(button as HTMLButtonElement).disabled),
    ).toBe(true);
  });

  it('shows in-flight and queue-failure states only on the row that was run', async () => {
    let resolveRun: (result: unknown) => void = () => {};
    runNeedsYouItemMutate.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRun = resolve;
      }),
    );
    listQuery.mockResolvedValue([
      row({ id: 'wi-2', kind: 'booking', subject: 'Confirm booking' }),
      row({ id: 'wi-3', kind: 'amendment', subject: 'Move dates' }),
    ]);
    const { container } = render(<Harness host="web" />);
    const bookingButton = await screen.findByRole('button', { name: 'Run HMS Confirm booking' });
    const amendmentButton = screen.getByRole('button', { name: 'Run HMS Move dates' });

    fireEvent.click(bookingButton);
    expect((bookingButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Checking HMS… about 2 min').closest('li')?.textContent).toContain(
      'Confirm booking',
    );
    expect((amendmentButton as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      resolveRun(foundRunResult('wi-2'));
    });
    expect(await screen.findByText('In HMS: found')).toBeDefined();

    runNeedsYouItemMutate.mockRejectedValueOnce(new Error('network down'));
    fireEvent.click(amendmentButton);
    const failure = await screen.findByRole('alert');
    expect(failure.textContent).toBe("Couldn't queue an HMS check. Try again.");
    expect(failure.closest('li')?.textContent).toContain('Move dates');
    expect(failure.closest('li')).not.toBe(container.querySelector('li:first-child'));
    expect((amendmentButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('says All caught up when nothing is open', async () => {
    listQuery.mockResolvedValue([]);
    render(<Harness host="web" onOpenThread={() => {}} />);

    expect(await screen.findByText('All caught up')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Needs you (0)' })).toBeDefined();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('a full list reads 200+ on the heading', async () => {
    listQuery.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => row({ id: `wi-${i}`, subject: `Item ${i}` })),
    );
    render(<Harness host="web" onOpenThread={() => {}} />);

    expect(await screen.findByRole('heading', { name: 'Needs you (200+)' })).toBeDefined();
  });

  it('shows a loading line, then a failed load with a retry that loads the list', async () => {
    listQuery.mockRejectedValueOnce(new Error('network down')).mockResolvedValue(TWO_OPEN);
    render(<Harness host="web" onOpenThread={() => {}} />);

    expect(screen.getByRole('status').textContent).toBe('Loading…');
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load the list.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Needs you (2)' })).toBeDefined();
  });

  it('webmail opens the thread of a row', async () => {
    const onOpenThread = vi.fn();
    render(<Harness host="web" onOpenThread={onOpenThread} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Confirm booking' }));
    expect(onOpenThread).toHaveBeenCalledWith('thread-wi-2');
  });

  it('Outlook has no open action, and says how to find each email', async () => {
    render(<Harness host="outlook" />);

    expect(await screen.findByRole('heading', { name: 'Needs you (2)' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Open/ })).toBeNull();
    expect(
      screen.getByText('Find each email in your Outlook inbox by its sender and subject.'),
    ).toBeDefined();
    expect(screen.getAllByText(/david@example\.com/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('listitem')[0]!.querySelector('time')).not.toBeNull();
  });

  it('dismiss sends the item to the server, takes its row off, and reloads the list', async () => {
    listQuery.mockResolvedValueOnce(TWO_OPEN).mockResolvedValue([TWO_OPEN[1]!]);
    render(<Harness host="web" onOpenThread={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Rooms request' }));
    expect(screen.queryByRole('button', { name: 'Dismiss Rooms request' })).toBeNull();
    expect(dismissMutate).toHaveBeenCalledWith({ workItemId: 'wi-1' });
    expect(await screen.findByRole('heading', { name: 'Needs you (1)' })).toBeDefined();
    await waitFor(() => expect(listQuery).toHaveBeenCalledTimes(2));
  });

  it('a refused dismiss puts the item back on the list and says so', async () => {
    dismissMutate.mockRejectedValueOnce(new Error('refused'));
    render(<Harness host="web" onOpenThread={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Rooms request' }));
    expect(
      await screen.findByText("Couldn't dismiss that email. It is still on your list."),
    ).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Dismiss Rooms request' })).toBeDefined();
  });

  it('a reload still in flight when a dismiss commits cannot bring the row back', async () => {
    render(<ReloadingHarness />);
    expect(await screen.findByRole('heading', { name: 'Needs you (2)' })).toBeDefined();

    // The reload waits. The load after the dismiss answers at once, so the waiting reload lands last.
    let answerReload: (rows: NeedsYouRow[]) => void = () => {};
    listQuery
      .mockImplementationOnce(
        () =>
          new Promise<NeedsYouRow[]>((resolve) => {
            answerReload = resolve;
          }),
      )
      .mockResolvedValueOnce([TWO_OPEN[1]!]);
    fireEvent.click(screen.getByRole('button', { name: 'Reload now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Rooms request' }));
    expect(await screen.findByRole('heading', { name: 'Needs you (1)' })).toBeDefined();
    await waitFor(() => expect(listQuery).toHaveBeenCalledTimes(3));

    await act(async () => {
      answerReload(TWO_OPEN);
    });
    expect(screen.getByRole('heading', { name: 'Needs you (1)' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Dismiss Rooms request' })).toBeNull();
  });

  it('a build without the list route reads as unavailable and does not throw', async () => {
    render(<Harness host="web" client={{}} />);

    expect(
      await screen.findByText('The Needs-you list is not available in this version yet.'),
    ).toBeDefined();
    expect(listQuery).not.toHaveBeenCalled();
  });
});

describe('Needs-you rows mark guest details for the preview gate (H6b)', () => {
  it('marks each row subject and sender with data-pii', async () => {
    listQuery.mockResolvedValue([
      row({ id: 'wi-1', sender: 'Priya Naidoo', subject: 'Booking for Mr Fixturemann' }),
    ]);
    const { container } = render(<Harness host="web" onOpenThread={() => {}} />);
    await screen.findAllByText('Booking for Mr Fixturemann');
    expect(unmaskedPii(container, ['Fixturemann', 'Priya Naidoo'])).toEqual([]);
  });
});

describe('Needs-you entry on the pane', () => {
  it('the Outlook pane opens the list from its entry, and Back returns to the quoting tool', async () => {
    render(<NavaPane bridge={fakeBridge} />);

    const entry = await screen.findByRole('button', { name: 'Needs you (2)' });
    expect(entry.className).toMatch(/max-w-\[96px\].*truncate.*whitespace-nowrap/);
    expect(entry.closest('header')).not.toBeNull();
    fireEvent.click(entry);
    expect(await screen.findByRole('heading', { name: 'Needs you (2)' })).toBeDefined();
    expect(
      screen.getByText('Find each email in your Outlook inbox by its sender and subject.'),
    ).toBeDefined();

    // The quoting tool stays mounted behind the list, so its state survives.
    expect(document.querySelector<HTMLElement>('main.nava-pane-scroll')?.style.display).toBe(
      'none',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back to quotes' }));
    expect(screen.queryByRole('heading', { name: 'Needs you (2)' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Needs you (2)' })).toBeDefined();
    expect(document.querySelector<HTMLElement>('main.nava-pane-scroll')?.style.display).toBe('');
  });

  it('Back reloads the pane count, so a dismiss made on the list shows on the entry', async () => {
    render(<NavaPane bridge={fakeBridge} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Needs you (2)' }));
    listQuery.mockResolvedValue([TWO_OPEN[1]!]);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Rooms request' }));
    await waitFor(() => expect(dismissMutate).toHaveBeenCalledWith({ workItemId: 'wi-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to quotes' }));
    expect(await screen.findByRole('button', { name: 'Needs you (1)' })).toBeDefined();
  });

  it('a dismiss on the list moves the entry count at once, with the list still open', async () => {
    render(<NavaPane bridge={fakeBridge} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Needs you (2)' }));
    listQuery.mockResolvedValue([TWO_OPEN[1]!]);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Rooms request' }));
    expect(await screen.findByRole('button', { name: 'Needs you (1)' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Needs you (1)' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Back to quotes' })).toBeDefined();
  });

  it('the webmail pane opens a row thread through the webmail callback', async () => {
    const onOpenThread = vi.fn();
    render(<NavaPane bridge={fakeBridge} preview onOpenThread={onOpenThread} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Needs you (2)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Rooms request' }));
    expect(onOpenThread).toHaveBeenCalledWith('thread-wi-1');
  });
});

describe('Needs-you webmail control', () => {
  it('the header button shows the count, opens the list in a dialog, and a row opens its thread and closes the dialog', async () => {
    const onOpenThread = vi.fn();
    render(<NeedsYouWebControl trpc={trpcClient} onOpenThread={onOpenThread} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Needs you (2)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Rooms request' }));
    expect(onOpenThread).toHaveBeenCalledWith('thread-wi-1');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Open Rooms request' })).toBeNull(),
    );
  });

  it('closing the dialog reloads the count, so a dismiss made inside it shows on the button', async () => {
    render(<NeedsYouWebControl trpc={trpcClient} onOpenThread={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Needs you (2)' }));
    listQuery.mockResolvedValue([TWO_OPEN[1]!]);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Rooms request' }));
    await waitFor(() => expect(dismissMutate).toHaveBeenCalledWith({ workItemId: 'wi-1' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(await screen.findByRole('button', { name: 'Needs you (1)' })).toBeDefined();
  });

  it('the dialog Close button closes it, and the count reloads', async () => {
    render(<NeedsYouWebControl trpc={trpcClient} onOpenThread={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Needs you (2)' }));
    listQuery.mockResolvedValue([TWO_OPEN[1]!]);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close' })).toBeNull());
    expect(await screen.findByRole('button', { name: 'Needs you (1)' })).toBeDefined();
  });

  it('a full list reads 200+ on the webmail count', async () => {
    listQuery.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => row({ id: `wi-${i}`, subject: `Item ${i}` })),
    );
    render(<NeedsYouWebControl trpc={trpcClient} onOpenThread={() => {}} />);

    expect(await screen.findByRole('button', { name: 'Needs you (200+)' })).toBeDefined();
  });
});
