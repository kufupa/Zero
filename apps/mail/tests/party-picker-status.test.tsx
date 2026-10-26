/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PartyPicker } from '../components/quote-workflow/party-picker';
import type { HmsJobTransport, HmsJobView } from '../lib/quote-workflow/amend-find';

afterEach(cleanup);

function sharedPartyJob(status: HmsJobView['status'], sourceMessageId: string): HmsJobView {
  return {
    runId: 'shared-party-run',
    sourceMessageId,
    request: { kind: 'party', name: 'Example Group', matchVersion: 2 },
    prefetch: true,
    status,
    position: null,
    attempts: 1,
    failureClass: status === 'failed' ? 'TRANSIENT_NETWORK' : null,
    asOf: null,
    createdAt: '2026-10-26T10:00:00.000Z',
    outcome: status === 'failed' ? 'execution_failure' : null,
    result: null,
  };
}

function partyFields(
  jobTransport: HmsJobTransport,
  sourceMessageId: string,
  agencySelected = false,
) {
  const shared = {
    parties: agencySelected
      ? { agency: { kind: 'agency' as const, nativeId: 'agency-1', name: 'Example Agency' } }
      : {},
    find: vi.fn(),
    jobTransport,
    threadId: 'thread-1',
    sourceMessageId,
    onPick: vi.fn(),
    onClear: vi.fn(),
  };

  return (
    <>
      <PartyPicker
        {...shared}
        autoLookup
        jobReadBackStatusOwner
        name="Example Agency"
        kind="agency"
      />
      <PartyPicker
        {...shared}
        autoLookup
        jobReadBackStatusOwner={agencySelected}
        name="Example Group"
        kind="company"
      />
    </>
  );
}

describe('PartyPicker shared job status', () => {
  it('announces one shared lookup and retains failure and Retry when Agency is already picked', async () => {
    let view = sharedPartyJob('running', 'message-1');
    const pendingReadbacks: Array<(result: HmsJobView | null) => void> = [];
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(async () => ({ runId: 'retry-run' })),
      jobQueueEnabled: vi.fn(() => new Promise<boolean>(() => {})),
      status: vi.fn((request: Parameters<HmsJobTransport['status']>[0]) =>
        'runId' in request
          ? Promise.resolve(view)
          : new Promise<HmsJobView | null>((resolve) => pendingReadbacks.push(resolve)),
      ),
    };
    const { rerender } = render(partyFields(jobTransport, 'message-1'));

    await waitFor(() => expect(pendingReadbacks).toHaveLength(2));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    await act(async () => {
      pendingReadbacks.splice(0).forEach((resolve) => resolve(view));
    });

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toContain('Running');
    expect(screen.getByRole('status').textContent).toContain(
      'Searching for the company or agency in HMS.',
    );

    view = sharedPartyJob('failed', 'message-2');
    rerender(partyFields(jobTransport, 'message-2', true));

    await waitFor(() => expect(pendingReadbacks).toHaveLength(1));
    await act(async () => {
      pendingReadbacks.splice(0).forEach((resolve) => resolve(view));
    });

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't reach HMS.");
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  });

  it('keeps inline lookup progress as the single status while job read-back is pending', async () => {
    const pendingReadbacks: Array<(result: HmsJobView | null) => void> = [];
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(async () => ({ runId: 'retry-run' })),
      status: vi.fn(() => new Promise<HmsJobView | null>((resolve) => pendingReadbacks.push(resolve))),
    };

    render(
      <PartyPicker
        autoLookup
        name="Example Company"
        kind="company"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-1"
        sourceMessageId="message-1"
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    await waitFor(() => expect(pendingReadbacks).toHaveLength(1));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toContain(
      'Searching HMS for "Example Company" (company)',
    );
    expect(screen.queryByText('Checking for a background HMS lookup…')).toBeNull();

    await act(async () => {
      pendingReadbacks[0](null);
    });
  });
});
