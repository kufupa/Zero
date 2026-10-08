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
    expect(screen.getByText(/Luna is working in HMS/)).toBeDefined();
    await advance(HMS_QUEUE_POLL_MS);
    expect(screen.getByText(/Luna is working in HMS/)).toBeDefined();
    await advance(HMS_QUEUE_POLL_MS);
    expect(screen.getByText('1 quote ahead of yours – about 6 minutes.')).toBeDefined();
  });
});

describe('HmsQueueStatusLine messages', () => {
  it('shows Starting the HMS run while the first read is idle, then the live message', async () => {
    const fetchStatus = vi.fn<() => Promise<QueueStatus | null>>()
      .mockResolvedValueOnce(IDLE)
      .mockResolvedValue(RUNNING);
    render(<Harness pending fetchStatus={fetchStatus} />);
    await advance(0);
    expect(screen.getByText('Starting the HMS run…')).toBeDefined();
    expect(screen.queryByText(/idle/i)).toBeNull();
    await advance(HMS_QUEUE_POLL_MS);
    expect(
      screen.getByText('Luna is working in HMS – step 2 of 3: Checking the quote rules. 1 min 20 s so far.'),
    ).toBeDefined();
  });

  it('shows the waiting message with the number of quotes ahead', async () => {
    render(<Harness pending fetchStatus={async () => WAITING} />);
    await advance(0);
    expect(screen.getByText('1 quote ahead of yours – about 6 minutes.')).toBeDefined();
  });

  it('shows the unavailable message as a red alert', async () => {
    render(<Harness pending fetchStatus={async () => UNAVAILABLE} />);
    await advance(0);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('HMS is not responding. Try again in a few minutes.');
    expect(alert.className).toContain('text-red-700');
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
    const line = screen.getByText(/Luna is working in HMS – step 2 of 3/);
    const steps = screen.getByText('Searches in HMS');
    expect(steps.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows Starting the HMS run in the panel before the first read lands', () => {
    render(<QuoteWorkflowPanel session={sessionWithRunningStep()} hmsQueue={{ pending: true, status: null }} />);
    expect(screen.getByText('Starting the HMS run…')).toBeDefined();
  });
});
