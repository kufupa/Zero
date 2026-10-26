/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HmsQueueStatusLine, formatQueueElapsed } from '../components/quote-workflow/hms-queue-status';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import { initialQuoteSession } from '../lib/quote-workflow/session';
import type { QueueStatus, QuoteSession } from '../lib/quote-workflow/types';
import { HMS_QUEUE_POLL_MS, useHmsQueueStatus } from '../lib/quote-workflow/use-hms-queue-status';

const RUNNING: QueueStatus = {
  state: 'running',
  phase: 'Checking the quote rules',
  phaseIndex: 2,
  phaseCount: 3,
  runningForMs: 80_000,
  message: 'Luna is working in HMS – step 2 of 3: Checking the quote rules.',
};
const WAITING: QueueStatus = {
  state: 'waiting',
  aheadCount: 1,
  etaMinutes: 6,
  message: '1 quote ahead of yours – about 6 minutes.',
};
const UNAVAILABLE: QueueStatus = {
  state: 'unavailable',
  message: 'HMS is not responding. Try again in a few minutes.',
};
const IDLE: QueueStatus = { state: 'idle', message: '' };

function Harness({
  pending,
  fetchStatus,
}: {
  pending: boolean;
  fetchStatus: () => Promise<QueueStatus | null>;
}) {
  const status = useHmsQueueStatus({ pending, fetchStatus });
  return <HmsQueueStatusLine pending={pending} status={status} />;
}

/** Runs the in-flight reads and any poll timers due within `ms`. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useHmsQueueStatus polling', () => {
  it('polls every 3 s only while a staff quote run is pending', async () => {
    const fetchStatus = vi.fn(async () => RUNNING);
    const { rerender } = render(<Harness pending fetchStatus={fetchStatus} />);
    await advance(0);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await advance(HMS_QUEUE_POLL_MS);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await advance(2 * HMS_QUEUE_POLL_MS);
    expect(fetchStatus).toHaveBeenCalledTimes(4);

    rerender(<Harness pending={false} fetchStatus={fetchStatus} />);
    await advance(10 * HMS_QUEUE_POLL_MS);
    expect(fetchStatus).toHaveBeenCalledTimes(4);
  });

  it('stops once the run settles as ready or unavailable, even if a read is still in flight', async () => {
    let resolveRead: (value: QueueStatus) => void = () => {};
    const fetchStatus = vi.fn(
      () => new Promise<QueueStatus>((resolve) => { resolveRead = resolve; }),
    );
    const { rerender, container } = render(<Harness pending fetchStatus={fetchStatus} />);
    rerender(<Harness pending={false} fetchStatus={fetchStatus} />);
    await act(async () => {
      resolveRead(RUNNING);
    });
    expect(container.textContent).toBe('');
    await advance(10 * HMS_QUEUE_POLL_MS);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('stops polling on unmount', async () => {
    const fetchStatus = vi.fn(async () => RUNNING);
    const { unmount } = render(<Harness pending fetchStatus={fetchStatus} />);
    await advance(0);
    unmount();
    await advance(10 * HMS_QUEUE_POLL_MS);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good status when a read fails', async () => {
    const fetchStatus = vi
      .fn<() => Promise<QueueStatus | null>>()
      .mockResolvedValueOnce(RUNNING)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(WAITING);
    render(<Harness pending fetchStatus={fetchStatus} />);
    await advance(0);
    expect(screen.getByRole('status').textContent).toContain('Running in HMS');
    await advance(HMS_QUEUE_POLL_MS);
    expect(screen.getByRole('status').textContent).toContain('Running in HMS');
    await advance(HMS_QUEUE_POLL_MS);
    expect(screen.getByRole('status').textContent).toContain('Queued · 1 quote ahead · about 6 minutes');
  });
});

describe('HmsQueueStatusLine messages', () => {
  it('keeps the wait visible with elapsed time while status detail changes, without a spinner', async () => {
    const fetchStatus = vi.fn<() => Promise<QueueStatus | null>>()
      .mockResolvedValueOnce(IDLE)
      .mockResolvedValue(RUNNING);
    render(<Harness pending fetchStatus={fetchStatus} />);
    await advance(0);
    const first = screen.getByRole('status');
    expect(first.textContent).toContain('Looking up in HMS — you can keep working');
    expect(first.textContent).toContain('0 s elapsed');
    expect(first.querySelector('svg')).toBeNull();
    expect(first.textContent).toContain('Queued');
    expect(screen.queryByText(/idle/i)).toBeNull();
    await advance(HMS_QUEUE_POLL_MS);
    const live = screen.getByRole('status');
    expect(live.textContent).toContain('Looking up in HMS — you can keep working');
    expect(live.textContent).toContain('1 min 20 s elapsed');
    expect(live.textContent).toContain('Running in HMS');
    expect(live.textContent).not.toContain('Luna is working in HMS');
  });

  it('shows a plain queued state and the number of quotes ahead', async () => {
    render(<Harness pending fetchStatus={async () => WAITING} />);
    await advance(0);
    expect(screen.getByRole('status').textContent).toContain('Queued');
    expect(screen.getByRole('status').textContent).toContain('1 quote ahead · about 6 minutes');
  });

  it('shows safe unavailable copy as a red alert', async () => {
    render(<Harness pending fetchStatus={async () => UNAVAILABLE} />);
    await advance(0);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Could not check HMS status. You can keep working and retry shortly.');
    expect(alert.textContent).not.toContain(UNAVAILABLE.message);
    expect(alert.className).toContain('text-red-700');
  });

  it('uses rates-specific progress copy for the main staff quote run', () => {
    render(<HmsQueueStatusLine pending status={RUNNING} staffQuote />);
    expect(screen.getByRole('status').textContent).toContain('Nava is getting rates from HMS — you can keep working');
    expect(screen.getByRole('status').textContent).toContain('Running in HMS');
    expect(screen.queryByText(RUNNING.message)).toBeNull();
  });

  it('separates the long-running reminder from the queue label', () => {
    render(<HmsQueueStatusLine pending status={RUNNING} />);
    expect(screen.getByRole('status').textContent).toContain(
      'Running in HMS · Still working — you can keep going',
    );
  });

  it('formats elapsed time as seconds, then minutes and seconds', () => {
    expect(formatQueueElapsed(0)).toBe('0 s');
    expect(formatQueueElapsed(45_000)).toBe('45 s');
    expect(formatQueueElapsed(80_000)).toBe('1 min 20 s');
    expect(formatQueueElapsed(120_999)).toBe('2 min 0 s');
  });

  it('renders nothing when the run is not pending', () => {
    const { container } = render(<HmsQueueStatusLine pending={false} status={RUNNING} />);
    expect(container.textContent).toBe('');
  });
});

describe('HMS queue line in the quote workflow panel', () => {
  function sessionWithRunningStep(): QuoteSession {
    return {
      ...initialQuoteSession(),
      phase: 'tools',
      steps: [
        {
          id: 'quote-1',
          kind: 'quote_stay',
          title: 'Search availability for 12–14 Nov',
          inputs: {},
          dependsOn: [],
          status: 'running',
        },
      ],
      runningStepId: 'quote-1',
    };
  }

  it('renders the live line after the quote steps while a run is pending', () => {
    render(
      <QuoteWorkflowPanel
        session={sessionWithRunningStep()}
        hmsQueue={{ pending: true, status: RUNNING }}
      />,
    );
    const line = screen.getByRole('status');
    expect(line.textContent).toContain('Nava is getting rates from HMS — you can keep working');
    expect(line.textContent).toContain('Running in HMS');
    expect(line.textContent).not.toContain(RUNNING.message);
    expect(line.querySelector('svg')).toBeNull();
  });

  it('shows the non-blocking HMS wait message before the first read lands', () => {
    render(<QuoteWorkflowPanel session={sessionWithRunningStep()} hmsQueue={{ pending: true, status: null }} />);
    expect(screen.getByRole('status').textContent).toContain('Nava is getting rates from HMS — you can keep working');
  });
});
