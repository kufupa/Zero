/**
 * @vitest-environment happy-dom
 */
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));

import { ratesReadyJobs, trackingStaffQuoteJob, useRatesReadyNotice } from '../lib/quote-workflow/rates-ready-notice';

afterEach(() => {
  cleanup();
  ratesReadyJobs.current = [];
  toast.mockReset();
});

describe('rates ready notice across pane remounts', () => {
  it('toasts once when the job started on a pane that was replaced by another thread', async () => {
    let status: 'running' | 'done' = 'running';
    const query = vi.fn(async ({ runId }: { runId: string }) => ({ runId, status }) as never);
    const first = renderHook(() =>
      useRatesReadyNotice({ jobsRef: ratesReadyJobs, openMessageId: 'mail-a', openEmailKey: '<a>', query }),
    );
    const tracked = trackingStaffQuoteJob(ratesReadyJobs, query, () => ({
      messageId: 'mail-a', threadId: 'thread-a', emailKey: '<a>', subject: 'Twin for 3 nights', entryId: null,
    }));
    await tracked!({ runId: 'run-1' } as never);
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
});
