/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HmsAsOf,
  HmsJobStatusLine,
  formatAsOfAgo,
  hmsJobLabel,
} from '../components/quote-workflow/hms-queue-status';
import {
  HMS_JOB_MAX_MISSES,
  HMS_JOB_POLL_MS,
  type HmsJobKind,
  type HmsJobQueueOptions,
  type HmsJobRequest,
  type HmsJobTransport,
  type HmsJobView,
} from '../lib/quote-workflow/amend-find';
import { useHmsJob } from '../lib/quote-workflow/use-hms-job';

// Local time on the fake clock's day, so the stamp reads "08:05" in any time zone.
const AS_OF = new Date(2026, 9, 9, 8, 5).toISOString();
const CONFIRMATION = '57291630-1';
const DETAIL = 'Nava is looking up the booking in HMS…';
const FIND: HmsJobRequest = { kind: 'find', confirmation: CONFIRMATION };
const SEARCH: HmsJobRequest = { kind: 'search_guest', lastName: 'Smith', arrival: '2026-11-12' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 9, 12, 0));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function view(overrides: Partial<HmsJobView> & Pick<HmsJobView, 'runId' | 'status'>): HmsJobView {
  return {
    request: FIND,
    prefetch: false,
    position: null,
    attempts: 1,
    failureClass: null,
    asOf: null,
    result: null,
    ...overrides,
  };
}

/**
 * A transport whose queue call hands out run ids in order. A poll by run id reads `polls` one per call, and the last
 * one repeats. A read by kind is the remount read-back, which answers `readBack`.
 */
function fakeTransport(polls: (HmsJobView | null)[], readBack: HmsJobView | null = null) {
  let queued = 0;
  let read = 0;
  const queue = vi.fn(async (_request: HmsJobRequest, _options?: HmsJobQueueOptions) => ({ runId: `run-${++queued}` }));
  const status = vi.fn(async (input: Parameters<HmsJobTransport['status']>[0]) => {
    if (!('runId' in input)) return readBack;
    const next = polls[Math.min(read, polls.length - 1)];
    read += 1;
    return next;
  });
  const transport: HmsJobTransport = { queue, status };
  return { transport, queue, status };
}

/** A panel's lookup, as the panels wire useHmsJob. */
function Harness({
  transport,
  request,
  resume = null,
  scope = 'email-1',
  autoStartIfMissing = false,
}: {
  transport: HmsJobTransport | null;
  request: HmsJobRequest;
  resume?: { kind: HmsJobKind; confirmation?: string; lastName?: string; arrival?: string } | null;
  scope?: string;
  autoStartIfMissing?: boolean;
}) {
  const job = useHmsJob({ transport, resume, scope, autoStartIfMissing });
  return (
    <div>
      <button type="button" onClick={() => job.start(request)}>
        Look up
      </button>
      <HmsJobStatusLine view={job.view} queuing={job.queuing} detail={DETAIL} onRetry={job.retry} />
      {job.view?.status === 'done' ? <HmsAsOf asOf={job.view.asOf} /> : null}
      {job.queueFailed ? <p>The lookup could not be queued.</p> : null}
    </div>
  );
}

async function lookUp() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
  });
}

/** Moves the fake clock on inside act, so each read's state change is rendered before the next assertion. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('the job label, shared by both surfaces', () => {
  it('reads Queued with the position, Running, Retrying or Failed, and nothing once the job is done', () => {
    expect(hmsJobLabel(view({ runId: 'r', status: 'queued', position: 2 }), false)).toBe('Queued (position 2)');
    expect(hmsJobLabel(view({ runId: 'r', status: 'queued' }), false)).toBe('Queued');
    expect(hmsJobLabel(view({ runId: 'r', status: 'running' }), false)).toBe('Running');
    expect(hmsJobLabel(view({ runId: 'r', status: 'retrying' }), false)).toBe('Retrying');
    expect(hmsJobLabel(view({ runId: 'r', status: 'failed' }), false)).toBe('Failed');
    expect(hmsJobLabel(view({ runId: 'r', status: 'done', asOf: AS_OF }), false)).toBeNull();
    expect(hmsJobLabel(null, false)).toBeNull();
  });

  it('reads Running while the queue call is still in flight', () => {
    expect(hmsJobLabel(null, true)).toBe('Running');
  });
});

describe('the status line', () => {
  it('shows the label and what is running, as a status with no action', () => {
    render(
      <HmsJobStatusLine
        view={view({ runId: 'r', status: 'queued', position: 2 })}
        queuing={false}
        detail={DETAIL}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('queued');
    expect(screen.getByText('Queued (position 2)')).toBeTruthy();
    expect(screen.getByText(DETAIL)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows time elapsed since the job entered the HMS lane', async () => {
    render(
      <HmsJobStatusLine
        view={view({
          runId: 'r',
          status: 'running',
          createdAt: new Date(2026, 9, 9, 11, 59).toISOString(),
        })}
        queuing={false}
        detail={DETAIL}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText(`${DETAIL} 1 min 0 s elapsed.`)).toBeTruthy();
    await advance(1_000);
    expect(screen.getByText(`${DETAIL} 1 min 1 s elapsed.`)).toBeTruthy();
  });

  it('shows Failed as an alert, and Retry calls onRetry', () => {
    const onRetry = vi.fn();
    render(
      <HmsJobStatusLine
        view={view({ runId: 'r', status: 'failed', failureClass: 'HMS_LOCK_BUSY' })}
        queuing={false}
        detail={DETAIL}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Failed');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when no job is in flight, or the job is done', () => {
    const { container, rerender } = render(
      <HmsJobStatusLine view={null} queuing={false} detail={DETAIL} onRetry={vi.fn()} />,
    );
    expect(container.textContent).toBe('');
    rerender(
      <HmsJobStatusLine
        view={view({ runId: 'r', status: 'done', asOf: AS_OF })}
        queuing={false}
        detail={DETAIL}
        onRetry={vi.fn()}
      />,
    );
    expect(container.textContent).toBe('');
  });
});

describe('the age on a dated HMS snapshot', () => {
  it('shows a relative age with the HMS label', () => {
    expect(formatAsOfAgo(AS_OF)).toBe('3 hr ago');
    render(<HmsAsOf asOf={AS_OF} />);
    expect(screen.getByTestId('hms-as-of').textContent).toBe('Looked up in HMS 3 hr ago');
  });

  it('reports the elapsed hours for an older snapshot', () => {
    render(<HmsAsOf asOf={new Date(2026, 9, 8, 17, 30).toISOString()} />);
    expect(screen.getByTestId('hms-as-of').textContent).toBe('Looked up in HMS 18 hr ago');
  });

  it('uses minutes below an hour, days after a day, and a non-future age for clock skew', () => {
    expect(formatAsOfAgo(AS_OF, new Date(2026, 9, 9, 8, 36))).toBe('31 min ago');
    expect(formatAsOfAgo(AS_OF, new Date(2026, 9, 11, 8, 6))).toBe('2 days ago');
    expect(formatAsOfAgo(new Date(Date.parse(AS_OF) + 60_000).toISOString(), new Date(AS_OF))).toBe('just now');
  });

  it('moves on while the card stays open, so an old result never reads "just now"', async () => {
    vi.setSystemTime(new Date(AS_OF));
    render(<HmsAsOf asOf={AS_OF} />);
    expect(screen.getByTestId('hms-as-of').textContent).toBe('Looked up in HMS just now');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000);
    });
    expect(screen.getByTestId('hms-as-of').textContent).toBe('Looked up in HMS 2 min ago');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(screen.getByTestId('hms-as-of').textContent).toBe('Looked up in HMS 1 hr ago');
  });

  it('shows nothing without a date, and no age for a value that is not a date', () => {
    const { container } = render(<HmsAsOf asOf={null} />);
    expect(container.textContent).toBe('');
    expect(formatAsOfAgo('not a date')).toBeNull();
  });
});

describe('a queued lookup, polled on the 3 s clock', () => {
  it('goes Queued (position 2), then Running, then done with its as-of stamp, and stops polling', async () => {
    const { transport, queue, status } = fakeTransport([
      view({ runId: 'run-1', status: 'queued', position: 2 }),
      view({ runId: 'run-1', status: 'running' }),
      view({ runId: 'run-1', status: 'done', asOf: AS_OF, result: { kind: 'find' } }),
    ]);
    render(<Harness transport={transport} request={FIND} />);
    await lookUp();
    await advance(0);
    expect(queue).toHaveBeenCalledWith(FIND);
    expect(screen.getByText('Queued (position 2)')).toBeTruthy();

    await advance(HMS_JOB_POLL_MS);
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.queryByText('Queued (position 2)')).toBeNull();

    await advance(HMS_JOB_POLL_MS);
    expect(screen.queryByTestId('hms-job-status')).toBeNull();
    expect(screen.getByTestId('hms-as-of').textContent).toBe('Looked up in HMS 3 hr ago');

    const reads = status.mock.calls.length;
    await advance(HMS_JOB_POLL_MS * 3);
    expect(status.mock.calls.length).toBe(reads);
  });
});

describe('a remount reads the job back from the database', () => {
  it('shows the stored job without queuing it again, and polls it to done', async () => {
    const running = view({ runId: 'run-9', status: 'running' });
    const { transport, queue, status } = fakeTransport(
      [running, view({ runId: 'run-9', status: 'done', asOf: AS_OF, result: { kind: 'find' } })],
      running,
    );
    render(<Harness transport={transport} request={FIND} resume={{ kind: 'find', confirmation: CONFIRMATION }} />);
    await advance(0);
    expect(status).toHaveBeenNthCalledWith(1, { kind: 'find', confirmation: CONFIRMATION });
    expect(screen.getByText('Running')).toBeTruthy();

    await advance(HMS_JOB_POLL_MS);
    expect(status).toHaveBeenNthCalledWith(2, { runId: 'run-9' });
    expect(screen.getByTestId('hms-as-of').textContent).toBe('Looked up in HMS 3 hr ago');
    expect(queue).not.toHaveBeenCalled();
  });
});

describe('a failed lookup', () => {
  it('shows Failed with a Retry that queues the same request again, then shows the result', async () => {
    const { transport, queue } = fakeTransport([
      view({ runId: 'run-1', status: 'failed', failureClass: 'HMS_LOCK_BUSY' }),
      view({ runId: 'run-2', status: 'done', asOf: AS_OF, result: { kind: 'search_guest' } }),
    ]);
    render(<Harness transport={transport} request={SEARCH} />);
    await lookUp();
    await advance(0);
    expect(screen.getByRole('alert').textContent).toContain('Failed');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await advance(0);
    expect(queue).toHaveBeenCalledTimes(2);
    expect(queue).toHaveBeenNthCalledWith(2, SEARCH);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('hms-as-of').textContent).toBe('Looked up in HMS 3 hr ago');
  });

  it('says so when the queue call itself fails, and shows no job', async () => {
    const transport: HmsJobTransport = {
      queue: vi.fn(async () => {
        throw new Error('socket closed');
      }),
      status: vi.fn(async () => null),
    };
    render(<Harness transport={transport} request={FIND} />);
    await lookUp();
    await advance(0);
    expect(screen.getByText('The lookup could not be queued.')).toBeTruthy();
    expect(screen.queryByTestId('hms-job-status')).toBeNull();
  });

  it('uses a fresh queue request when retrying an auto-started job with a terminal failure', async () => {
    const { transport, queue } = fakeTransport([
      view({ runId: 'run-1', request: SEARCH, status: 'failed', failureClass: 'HMS_LOCK_BUSY' }),
      view({ runId: 'run-2', request: SEARCH, status: 'done', asOf: AS_OF, result: { kind: 'search_guest' } }),
    ]);
    render(
      <Harness
        transport={transport}
        request={SEARCH}
        resume={{ kind: 'search_guest', lastName: 'Smith', arrival: '2026-11-12' }}
        autoStartIfMissing
      />,
    );
    await advance(0);
    expect(queue).toHaveBeenNthCalledWith(1, SEARCH, { autoStart: true });
    expect(screen.getByRole('alert').textContent).toContain('Failed');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await advance(0);

    expect(queue).toHaveBeenCalledTimes(2);
    expect(queue).toHaveBeenNthCalledWith(2, SEARCH);
    expect(screen.getByTestId('hms-as-of').textContent).toBe('Looked up in HMS 3 hr ago');
  });
});

describe('a job that stops answering', () => {
  it('stops polling after about a minute of unreadable answers, and shows the last job as Failed with Retry', async () => {
    const { transport, status } = fakeTransport([view({ runId: 'run-1', status: 'running' }), null]);
    render(<Harness transport={transport} request={FIND} />);
    await lookUp();
    await advance(0);
    expect(screen.getByText('Running')).toBeTruthy();

    await advance(HMS_JOB_POLL_MS * 21);
    expect(screen.getByRole('alert').textContent).toContain('Failed');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();

    const reads = status.mock.calls.length;
    await advance(HMS_JOB_POLL_MS * 5);
    expect(status.mock.calls.length).toBe(reads);
  });
});

describe('a resumed job whose polling was lost', () => {
  it('Retry polls the same run again and queues nothing', async () => {
    const running = view({ runId: 'run-9', request: FIND, status: 'running' });
    const done = view({ runId: 'run-9', request: FIND, status: 'done', asOf: AS_OF, result: { kind: 'find' } });
    // One readable poll, then unreadable polls until polling gives up, then the run finishes on HMS.
    const polls: (HmsJobView | null)[] = [running, ...Array<HmsJobView | null>(HMS_JOB_MAX_MISSES).fill(null), done];
    const { transport, queue, status } = fakeTransport(polls, running);
    render(<Harness transport={transport} request={FIND} resume={{ kind: 'find', confirmation: CONFIRMATION }} />);
    await advance(0);
    expect(screen.getByText('Running')).toBeTruthy();

    await advance(HMS_JOB_POLL_MS * (HMS_JOB_MAX_MISSES + 1));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    await advance(0);
    expect(status).toHaveBeenLastCalledWith({ runId: 'run-9' });
    expect(screen.getByTestId('hms-as-of')).toBeTruthy();
    expect(queue).not.toHaveBeenCalled();
  });
});

describe('a change of email', () => {
  it('clears the job on screen, and reads nothing back for the new email', async () => {
    const { transport, status } = fakeTransport([
      view({ runId: 'run-1', status: 'done', asOf: AS_OF, result: { kind: 'find' } }),
    ]);
    const { rerender } = render(<Harness transport={transport} request={FIND} scope="email-1" />);
    await lookUp();
    await advance(0);
    expect(screen.getByTestId('hms-as-of')).toBeTruthy();

    rerender(<Harness transport={transport} request={FIND} scope="email-2" />);
    await advance(0);
    expect(screen.queryByTestId('hms-as-of')).toBeNull();
    expect(status).toHaveBeenCalledTimes(1);
  });
});
