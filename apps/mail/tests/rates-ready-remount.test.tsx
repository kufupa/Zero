/**
 * @vitest-environment happy-dom
 */
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));

import { ratesReadyJobs, trackingStaffQuoteJob, useRatesReadyNotice } from '../lib/quote-workflow/rates-ready-notice';
import type { StaffQuoteJobQuery } from '../lib/quote-workflow/staff-quote-bind';

afterEach(() => {
  cleanup();
  ratesReadyJobs.current = [];
  toast.mockReset();
});

describe('rates ready notice across pane remounts', () => {
  it('toasts once when the job started on a pane that was replaced by another thread', async () => {
    let status: 'running' | 'done' = 'running';
    const query: StaffQuoteJobQuery = vi.fn(async () => ({ runId: 'run-1', status, result: null, failureClass: null }));
    const first = renderHook(() =>
      useRatesReadyNotice({ jobsRef: ratesReadyJobs, openMessageId: 'mail-a', openEmailKey: '<a>', query }),
    );
    const tracked = trackingStaffQuoteJob(ratesReadyJobs, query, () => ({
      messageId: 'mail-a', threadId: 'thread-a', emailKey: '<a>', subject: 'Twin for 3 nights', entryId: null,
    }));
    await tracked!({ runId: 'run-1', messageId: 'mail-a' });
    first.unmount();

    status = 'done';
    const onOpenThread = vi.fn();
    const second = renderHook(() =>
      useRatesReadyNotice({ jobsRef: ratesReadyJobs, openMessageId: 'mail-b', openEmailKey: '<b>', query, onOpenThread }),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0]?.[0]).toBe('Rates ready · Twin for 3 nights');
    second.unmount();

    renderHook(() =>
      useRatesReadyNotice({ jobsRef: ratesReadyJobs, openMessageId: 'mail-c', openEmailKey: '<c>', query, onOpenThread }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('does not toast later for a job that finished while its own mail was open', async () => {
    const query: StaffQuoteJobQuery = vi.fn(async () => ({ runId: 'run-2', status: 'done' as const, result: null, failureClass: null }));
    const tracked = trackingStaffQuoteJob(ratesReadyJobs, query, () => ({
      messageId: 'mail-a', threadId: 'thread-a', emailKey: '<a>', subject: 'Seen on screen', entryId: null,
    }));
    const first = renderHook(() =>
      useRatesReadyNotice({ jobsRef: ratesReadyJobs, openMessageId: 'mail-a', openEmailKey: '<a>', query }),
    );
    await tracked!({ runId: 'run-2', messageId: 'mail-a' });
    await waitFor(() => expect(ratesReadyJobs.current).toEqual([]), { timeout: 5000 });
    first.unmount();
    renderHook(() => useRatesReadyNotice({ jobsRef: ratesReadyJobs, openMessageId: 'mail-b', openEmailKey: '<b>', query }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toast).not.toHaveBeenCalled();
  });

  it('stops polling a failed job', async () => {
    const query = vi.fn<StaffQuoteJobQuery>(async () => ({ runId: 'run-3', status: 'failed' as const, result: null, failureClass: 'RUN_DEADLINE' }));
    renderHook(() => useRatesReadyNotice({ jobsRef: ratesReadyJobs, openMessageId: 'mail-b', openEmailKey: '<b>', query }));
    await trackingStaffQuoteJob(ratesReadyJobs, query, () => ({
      messageId: 'mail-a', threadId: 'thread-a', emailKey: '<a>', subject: 'Failed', entryId: null,
    }))!({ runId: 'run-3', messageId: 'mail-a' });
    await waitFor(() => expect(ratesReadyJobs.current).toEqual([]), { timeout: 5000 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });
});
