/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HmsAsOf, HmsJobStatusLine, formatAsOfTime, hmsJobLabel } from '../components/quote-workflow/hms-queue-status';
import {
  HMS_JOB_POLL_MS,
  type HmsJobKind,
  type HmsJobRequest,
  type HmsJobTransport,
  type HmsJobView,
} from '../lib/quote-workflow/amend-find';
import { useHmsJob } from '../lib/quote-workflow/use-hms-job';

const AS_OF = '2026-10-09T08:05:00.000Z';
const CONFIRMATION = '57291630-1';
const DETAIL = 'Nava is looking up the booking in HMS…';
const FIND: HmsJobRequest = { kind: 'find', confirmation: CONFIRMATION };
const SEARCH: HmsJobRequest = { kind: 'search_guest', lastName: 'Smith', arrival: '2026-11-12' };

beforeEach(() => {
  vi.useFakeTimers();
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
function fakeTransport(polls: HmsJobView[], readBack: HmsJobView | null = null) {
  let queued = 0;
  let read = 0;
  const queue = vi.fn(async (_request: HmsJobRequest) => ({ runId: `run-${++queued}` }));
  const status = vi.fn(async (input: { runId: string } | { kind: HmsJobKind; confirmation?: string }) => {
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
}: {
  transport: HmsJobTransport | null;
  request: HmsJobRequest;
  resume?: { kind: HmsJobKind; confirmation?: string } | null;
  scope?: string;
}) {
  const job = useHmsJob({ transport, resume, scope });
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

describe('the as-of stamp on a dated snapshot', () => {
  it('shows As of HH:MM in local time, the same time formatAsOfTime gives', () => {
    const time = formatAsOfTime(AS_OF);
    expect(time).toMatch(/^\d{2}:\d{2}$/);
    render(<HmsAsOf asOf={AS_OF} />);
    expect(screen.getByTestId('hms-as-of').textContent).toBe(`As of ${time}`);
  });

  it('shows nothing without a date, and no time for a value that is not a date', () => {
    const { container } = render(<HmsAsOf asOf={null} />);
    expect(container.textContent).toBe('');
    expect(formatAsOfTime('not a date')).toBeNull();
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
    expect(screen.getByTestId('hms-as-of').textContent).toBe(`As of ${formatAsOfTime(AS_OF)}`);

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
    expect(screen.getByTestId('hms-as-of').textContent).toBe(`As of ${formatAsOfTime(AS_OF)}`);
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
    expect(screen.getByTestId('hms-as-of').textContent).toBe(`As of ${formatAsOfTime(AS_OF)}`);
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
