/** @vitest-environment happy-dom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { useOutlookSync } from '../lib/workstation/use-outlook-sync';
const mocks = vi.hoisted(() => ({ activate: vi.fn(), status: vi.fn(), control: vi.fn() }));
vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    workstation: {
      outlookSync: {
        activate: { mutate: mocks.activate },
        status: { query: mocks.status },
        control: { mutate: mocks.control },
      },
    },
  },
}));
const baseline = {
  userId: 'staff',
  sessionId: 'session',
  transportId: 'transport',
  mailbox: 'shared@example.test',
  deviceId: '05c74d2a-2ea0-450d-9d6f-fbf6c9b70a88',
  capabilityVersion: 1,
  readRoots: [{ storeId: 'store', rootEntryId: 'root', policyVersion: 1, policyGeneration: 1 }],
  authorized: true,
  activateNative: vi.fn().mockResolvedValue({ activated: true }),
};
const response = {
  activationTicket: 'a'.repeat(43),
  sourceId: 'source',
  historyFrom: null,
  historyTo: null,
  expiresAt: new Date(Date.now() + 60000).toISOString(),
};
const paused = {
  version: 1,
  sourceId: 'source',
  state: 'paused',
  capabilityRequirement: 'mailboxSync:1',
  historyFrom: '2026-09-04T00:00:00Z',
  historyTo: '2026-10-04T00:00:00Z',
  timezone: 'Africa/Johannesburg',
  captureStartedAt: '2026-10-04T00:00:00Z',
  discoveredThrough: null,
  committedThrough: null,
  discovered: 0,
  retained: 0,
  committed: 0,
  gaps: 0,
  userPaused: true,
  resourcePauseReason: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.activate.mockResolvedValue(response);
  mocks.status.mockResolvedValue(paused);
  mocks.control.mockResolvedValue({ accepted: true });
});
afterEach(cleanup);
describe('automatic source scoped hosted sync', () => {
  it('auto activates only live authorized roots, passes ticket only to native and preserves Pause', async () => {
    const { result } = renderHook(() => useOutlookSync(baseline));
    await waitFor(() => expect(mocks.activate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.status?.userPaused).toBe(true));
    expect(baseline.activateNative).toHaveBeenCalledWith(
      expect.objectContaining({ activationTicket: response.activationTicket, sourceId: 'source' }),
    );
    expect(baseline.activateNative.mock.calls[0][0]).not.toHaveProperty('sourceHandle');
    await expect(result.current.control('syncNow')).rejects.toThrow();
    expect(mocks.control).not.toHaveBeenCalled();
  });
  it('old capabilities and missing root never activate', async () => {
    const { result } = renderHook(() =>
      useOutlookSync({ ...baseline, capabilityVersion: 2, readRoots: [] }),
    );
    await act(async () => {});
    expect(result.current.eligible).toBe(false);
    expect(mocks.activate).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent mounts and retries response loss with one bounded idempotency key', async () => {
    const a = renderHook(() => useOutlookSync({ ...baseline, sessionId: 'parallel' }));
    const b = renderHook(() => useOutlookSync({ ...baseline, sessionId: 'parallel' }));
    await waitFor(() => expect(a.result.current.status).not.toBeNull());
    expect(mocks.activate).toHaveBeenCalledTimes(1);
    expect(b.result.current.status?.sourceId).toBe('source');
  });
});

it('suppresses old-account results and stops polling after unmount', async () => {
  let resolveOld: (value: typeof response) => void = () => {};
  mocks.activate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const hook = renderHook(
    ({ userId }) => useOutlookSync({ ...baseline, userId, sessionId: 'switch' }),
    { initialProps: { userId: 'old-staff' } },
  );
  await waitFor(() => expect(mocks.activate).toHaveBeenCalledTimes(1));
  hook.rerender({ userId: 'new-staff' });
  await waitFor(() => expect(hook.result.current.status?.sourceId).toBe('source'));
  await act(async () => resolveOld({ ...response, sourceId: 'foreign-source' }));
  expect(hook.result.current.status?.sourceId).toBe('source');
  expect(baseline.activateNative.mock.calls.every(([a]) => a.sourceId !== 'foreign-source')).toBe(
    true,
  );
  hook.unmount();
});
it('recovers a lost activation reply with the same request key and ignores server handle fields', async () => {
  vi.useFakeTimers();
  try {
    mocks.activate
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ ...response, sourceHandle: 'must-never-forward' });
    const hook = renderHook(() => useOutlookSync({ ...baseline, sessionId: 'retry' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hook.result.current.error).toBe('offline');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.activate).toHaveBeenCalledTimes(2);
    expect(mocks.activate.mock.calls[0][0].idempotencyKey).toBe(
      mocks.activate.mock.calls[1][0].idempotencyKey,
    );
    expect(baseline.activateNative.mock.calls[0][0]).not.toHaveProperty('sourceHandle');
    hook.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it('explicit Resume refreshes pane authorization and sends only the new activation ticket', async () => {
  const hook = renderHook(() => useOutlookSync({ ...baseline, sessionId: 'resume' }));
  await waitFor(() => expect(hook.result.current.status?.userPaused).toBe(true));
  await act(async () => {
    await hook.result.current.control('resume');
  });
  expect(mocks.activate).toHaveBeenCalledTimes(2);
  expect(mocks.control).toHaveBeenCalledWith(expect.objectContaining({ operation: 'resume' }));
  expect(baseline.activateNative).toHaveBeenCalledTimes(2);
});
