/** @vitest-environment happy-dom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setMailCacheScope } from '@/lib/mail/mail-cache-scope';
import type { RecordFieldEventInput, StoredWork } from '@/lib/quote-workflow/backend-bind';
import type { StayGroupRequirement } from '@/lib/quote-workflow/types';
import { useStoredWork, WORK_EVENT_DEBOUNCE_MS, WORK_EVENT_RETRY_MS } from '@/lib/quote-workflow/use-work-item';

const row: StayGroupRequirement = {
  id: 'r1', stayId: 's1', arrivalDate: '2027-10-20', departureDate: '2027-10-21', quantity: 1,
  adults: 2, childrenAges: [], board: 'bb', specialRequests: [], fields: {},
};
const ready: Extract<StoredWork, { status: 'ready' }> = {
  status: 'ready', kind: 'quote', workItemId: 'wi-1', workItemStatus: 'needs_you', extractionId: 'ex-1',
  refs: { r1: { stayId: 's1', rowId: 'r1' } },
  analysis: { intent: 'quote', groups: [row], secondaryAsks: [], alternatives: [] },
  contact: { name: null, company: null, endClient: null, email: null, phone: null },
  language: null, translation: null,
};
const scope = (userId: string, transportId = 'transport-a') => `${userId}:session:${transportId}`;
const mailbox = (userId: string, transportId = 'transport-a') => setMailCacheScope({ userId, activeTransportId: transportId });
type OwnedEdit = RecordFieldEventInput & { expectedUserId: string };

function harness() {
  let authenticatedUser = 'staff-a';
  const written: OwnedEdit[] = [];
  const owned = vi.fn(async (input: OwnedEdit, _options?: unknown) => {
    if (input.expectedUserId !== authenticatedUser) throw new Error('authenticated user changed');
    written.push(input);
    return { aiValue: null, value: input.value };
  });
  const legacy = vi.fn(async () => ({ aiValue: null, value: null }));
  const query = vi.fn(async () => ready);
  const trpc = { workItems: { getByMessage: { query }, recordEvent: { mutate: legacy }, recordOwnedEvent: { mutate: owned } } };
  return { trpc, owned, legacy, written, authenticate: (user: string) => { authenticatedUser = user; } };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setMailCacheScope({ userId: null, activeTransportId: null });
  sessionStorage.clear();
});

describe('work-item field save owner', () => {
  it('cannot write an A edit with B cookies and holds it after B edits the same field', async () => {
    mailbox('staff-a');
    const h = harness();
    const hook = renderHook(({ owner }) => useStoredWork({ trpc: h.trpc, internetMessageId: 'm-1', scope: scope(owner) }),
      { initialProps: { owner: 'staff-a' } });
    await waitFor(() => expect(hook.result.current.pane.state).toBe('ready'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    act(() => hook.result.current.recordGroups([row], [{ ...row, quantity: 4 }]));
    h.authenticate('staff-b'); // Cookie changes before the cache or React notices.
    await act(async () => { await vi.advanceTimersByTimeAsync(WORK_EVENT_DEBOUNCE_MS); });
    expect(h.owned.mock.calls[0]?.[0]).toMatchObject({ expectedUserId: 'staff-a', value: 4 });
    expect(h.written).toEqual([]);

    act(() => mailbox('staff-b'));
    await act(async () => { hook.rerender({ owner: 'staff-b' }); await vi.advanceTimersByTimeAsync(0); });
    expect(hook.result.current.pane.state).toBe('ready');
    act(() => hook.result.current.recordGroups([row], [{ ...row, quantity: 5 }]));
    await act(async () => { expect(await hook.result.current.flushEdits()).toBe(true); });
    expect(h.written).toEqual([expect.objectContaining({ expectedUserId: 'staff-b', value: 5 })]);

    h.authenticate('staff-a');
    act(() => mailbox('staff-a'));
    await act(async () => { hook.rerender({ owner: 'staff-a' }); await vi.advanceTimersByTimeAsync(WORK_EVENT_RETRY_MS); });
    expect(hook.result.current.saveError).toContain('Review and re-enter');
    const calls = h.owned.mock.calls.length;
    await act(async () => { hook.result.current.retrySave(); await vi.advanceTimersByTimeAsync(0); });
    expect(h.owned).toHaveBeenCalledTimes(calls);
    expect(h.written).toHaveLength(1);
  });

  it('fails closed when the server has only the legacy field-event route', async () => {
    mailbox('staff-a');
    const h = harness();
    const trpc = { workItems: { getByMessage: h.trpc.workItems.getByMessage, recordEvent: h.trpc.workItems.recordEvent } };
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: scope('staff-a') }));
    await waitFor(() => expect(result.current.pane.state).toBe('ready'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    act(() => result.current.recordGroups([row], [{ ...row, quantity: 4 }]));
    await act(async () => { await vi.advanceTimersByTimeAsync(WORK_EVENT_DEBOUNCE_MS); });
    expect(h.legacy).not.toHaveBeenCalled();
    expect(result.current.saveFailed).toBe(true);
    await act(async () => expect(await result.current.flushEdits()).toBe(false));
  });

  it('keeps a same-user mailbox switch pinned to the original transport', async () => {
    mailbox('staff-a');
    const h = harness();
    const hook = renderHook(({ transport }) => useStoredWork({ trpc: h.trpc, internetMessageId: 'm-1', scope: scope('staff-a', transport) }),
      { initialProps: { transport: 'transport-a' } });
    await waitFor(() => expect(hook.result.current.pane.state).toBe('ready'));
    act(() => hook.result.current.recordGroups([row], [{ ...row, quantity: 4 }]));
    act(() => mailbox('staff-a', 'transport-b'));
    await act(async () => { hook.rerender({ transport: 'transport-b' }); await Promise.resolve(); });
    expect(h.owned).toHaveBeenCalledWith(expect.objectContaining({ expectedUserId: 'staff-a', value: 4 }),
      { context: { activeTransportId: 'transport-a' } });
    expect(h.written).toHaveLength(1);
  });

  it('does not discard A’s queued edit when the cache has already changed to B', async () => {
    mailbox('staff-a');
    const h = harness();
    const undo = vi.fn(async () => ({ revision: 0, revisionHead: 1, seq: 2 }));
    const cursor = vi.fn(async () => ({ revision: 1, revisionHead: 1, seq: 1 }));
    const trpc = { workItems: { ...h.trpc.workItems, revisionCursor: { query: cursor },
      undoRevision: { mutate: undo }, redoRevision: { mutate: undo } } };
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: scope('staff-a') }));
    await waitFor(() => expect(result.current.historyCursor).toMatchObject({ revision: 1 }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    act(() => result.current.recordGroups([row], [{ ...row, quantity: 4 }]));
    act(() => mailbox('staff-b'));
    act(() => result.current.undo('wi-1', 1));
    expect(undo).not.toHaveBeenCalled();
    expect(result.current.historyError).toContain('staff account changed');
    act(() => mailbox('staff-a'));
    await act(async () => { await vi.advanceTimersByTimeAsync(WORK_EVENT_DEBOUNCE_MS); });
    expect(h.written).toEqual([expect.objectContaining({ expectedUserId: 'staff-a', value: 4 })]);
  });
});
