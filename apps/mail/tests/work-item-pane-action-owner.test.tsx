/** @vitest-environment happy-dom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setMailCacheScope } from '@/lib/mail/mail-cache-scope';
import type { OwnedPaneAction, RecordFieldEventInput, StoredWork } from '@/lib/quote-workflow/backend-bind';
import type { StayGroupRequirement } from '@/lib/quote-workflow/types';
import { useStoredWork, WORK_EVENT_DEBOUNCE_MS } from '@/lib/quote-workflow/use-work-item';

const row: StayGroupRequirement = {
  id: 'r1', stayId: 's1', arrivalDate: '2027-10-20', departureDate: '2027-10-21', quantity: 1,
  adults: 2, childrenAges: [], board: 'bb', specialRequests: [], fields: {},
};
const ready: Extract<StoredWork, { status: 'ready' }> = {
  status: 'ready', kind: 'quote', workItemId: 'wi-1', workItemStatus: 'needs_you', extractionId: 'ex-1',
  refs: { r1: { stayId: 's1', rowId: 'r1' } },
  analysis: { intent: 'quote', groups: [row], secondaryAsks: [], alternatives: [] },
  contact: { name: null, company: null, endClient: null, email: null, phone: null }, language: null, translation: null,
};
const scope = (user: string, transport = 'transport-a') => `${user}:session:${transport}`;
const mailbox = (user: string, transport = 'transport-a') => setMailCacheScope({ userId: user, activeTransportId: transport });
const PINNED = { context: { activeTransportId: 'transport-a' } };

function harness() {
  let authenticated = 'staff-a';
  const actions: OwnedPaneAction[] = [];
  const action = vi.fn(async (input: OwnedPaneAction, _opts?: unknown): Promise<unknown> => {
    if (input.expectedUserId !== authenticated) throw new Error('account changed');
    actions.push(input);
    if (input.action === 'accept') return { accepted: 1 };
    if (input.action === 'reset') return { reset: 1 };
    return { revision: 0, revisionHead: 1, seq: 2 };
  });
  const record = vi.fn(async (input: RecordFieldEventInput & { expectedUserId: string }, _opts?: unknown): Promise<unknown> => {
    if (input.expectedUserId !== authenticated) throw new Error('account changed');
    return { value: input.value, aiValue: null };
  });
  const query = vi.fn(async () => ready);
  const cursor = vi.fn(async () => ({ revision: 1, revisionHead: 1, seq: 1 }));
  const legacy = vi.fn(async () => ({}));
  const trpc = { workItems: { getByMessage: { query }, revisionCursor: { query: cursor },
    recordOwnedEvent: { mutate: record }, ownedPaneAction: { mutate: action }, acceptFields: { mutate: legacy },
    undoRevision: { mutate: legacy }, redoRevision: { mutate: legacy }, resetSection: { mutate: legacy } } };
  return { trpc, query, action, record, actions, legacy, authenticate: (user: string) => { authenticated = user; } };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setMailCacheScope({ userId: null, activeTransportId: null });
  sessionStorage.clear();
});

describe('owner-bound pane actions', () => {
  it.each(['undo', 'redo', 'reset'] as const)(
    'holds a queued edit if %s reaches the server after the cookie switches', async (kind) => {
      mailbox('staff-a');
      const h = harness();
      const { result } = renderHook(() => useStoredWork({ trpc: h.trpc, internetMessageId: 'm-1', scope: scope('staff-a') }));
      await waitFor(() => expect(result.current.historyCursor).toMatchObject({ revision: 1 }));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      act(() => {
        if (kind === 'reset') result.current.recordContact('name', 'Pending name');
        else result.current.recordGroups([row], [{ ...row, quantity: 4 }]);
        if (kind === 'undo') result.current.undo('wi-1', 1);
        if (kind === 'redo') result.current.redo('wi-1', 1);
        if (kind === 'reset') result.current.resetSection({ type: 'contact' });
        h.authenticate('staff-b'); // The cookie changes before React or the scope cache updates.
      });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(h.action).toHaveBeenCalledWith(expect.objectContaining({ action: kind, expectedUserId: 'staff-a' }), PINNED);
      expect(h.actions).toEqual([]);
      expect(result.current.saveError).toMatch(/could not be confirmed.*re-enter/i);
      await act(async () => { result.current.retrySave(); await vi.advanceTimersByTimeAsync(WORK_EVENT_DEBOUNCE_MS * 2); });
      expect(h.record).not.toHaveBeenCalled();

      h.authenticate('staff-a');
      act(() => {
        if (kind === 'reset') result.current.recordContact('name', 'Reviewed name');
        else result.current.recordGroups([row], [{ ...row, quantity: 5 }]);
      });
      await act(async () => expect(await result.current.flushEdits()).toBe(true));
      expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ expectedUserId: 'staff-a',
        value: kind === 'reset' ? 'Reviewed name' : 5 }), PINNED);
    },
  );

  it('does not discard the pending edit before the action is acknowledged', async () => {
    mailbox('staff-a');
    const h = harness();
    let finish!: (value: unknown) => void;
    h.action.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useStoredWork({ trpc: h.trpc, internetMessageId: 'm-1', scope: scope('staff-a') }));
    await waitFor(() => expect(result.current.historyCursor).toMatchObject({ revision: 1 }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    act(() => { result.current.recordGroups([row], [{ ...row, quantity: 4 }]); result.current.undo('wi-1', 1); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(WORK_EVENT_DEBOUNCE_MS * 2); });
    expect(h.record).not.toHaveBeenCalled();
    await act(async () => { finish({ revision: 0, revisionHead: 1, seq: 2 }); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(WORK_EVENT_DEBOUNCE_MS * 2); });
    expect(h.record).not.toHaveBeenCalled();
    expect(result.current.historyPending).toBe(false);
    expect(result.current.saveFailed).toBe(false);
  });

  it('holds the pending edit if the server response lacks a valid acknowledgement', async () => {
    mailbox('staff-a');
    const h = harness();
    h.action.mockResolvedValueOnce({});
    const { result } = renderHook(() => useStoredWork({ trpc: h.trpc, internetMessageId: 'm-1', scope: scope('staff-a') }));
    await waitFor(() => expect(result.current.historyCursor).toMatchObject({ revision: 1 }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    act(() => { result.current.recordGroups([row], [{ ...row, quantity: 4 }]); result.current.undo('wi-1', 1); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.saveError).toMatch(/could not be confirmed.*re-enter/i);
    await act(async () => { result.current.retrySave(); await vi.advanceTimersByTimeAsync(WORK_EVENT_DEBOUNCE_MS * 2); });
    expect(h.record).not.toHaveBeenCalled();
  });

  it('retains an unrelated unsaved stay edit when reset targets contact', async () => {
    mailbox('staff-a');
    const h = harness();
    const { result } = renderHook(() => useStoredWork({ trpc: h.trpc, internetMessageId: 'm-1', scope: scope('staff-a') }));
    await waitFor(() => expect(result.current.historyCursor).toMatchObject({ revision: 1 }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    act(() => { result.current.recordGroups([row], [{ ...row, quantity: 4 }]); result.current.resetSection({ type: 'contact' }); });
    expect(result.current.historyError).toMatch(/other unsaved changes/i);
    expect(h.action).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(WORK_EVENT_DEBOUNCE_MS); });
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ value: 4, expectedUserId: 'staff-a' }), PINNED);
  });

  it('keeps an action pinned to the original mailbox when the same user switches during the request', async () => {
    mailbox('staff-a');
    const h = harness();
    let finish!: (value: unknown) => void;
    h.action.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const hook = renderHook(({ transport }) => useStoredWork({ trpc: h.trpc, internetMessageId: 'm-1',
      scope: scope('staff-a', transport) }), { initialProps: { transport: 'transport-a' } });
    await waitFor(() => expect(hook.result.current.historyCursor).toMatchObject({ revision: 1 }));
    act(() => { hook.result.current.recordGroups([row], [{ ...row, quantity: 4 }]); hook.result.current.undo('wi-1', 1); });
    await waitFor(() => expect(h.action).toHaveBeenCalledTimes(1));
    expect(h.action).toHaveBeenCalledWith(expect.objectContaining({ action: 'undo', expectedUserId: 'staff-a' }), PINNED);
    act(() => mailbox('staff-a', 'transport-b'));
    hook.rerender({ transport: 'transport-b' });
    await act(async () => { finish({ revision: 0, revisionHead: 1, seq: 2 }); await Promise.resolve(); });
    await waitFor(() => expect(hook.result.current.pane.state).toBe('ready'));
    expect(h.record).not.toHaveBeenCalled();
    expect(hook.result.current.historyEpoch).toBe(0);
  });

  it('holds edits made while an acknowledged history action is pending instead of refreshing them away', async () => {
    mailbox('staff-a');
    const h = harness();
    let finish!: (value: unknown) => void;
    h.action.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useStoredWork({ trpc: h.trpc, internetMessageId: 'm-1', scope: scope('staff-a') }));
    await waitFor(() => expect(result.current.historyCursor).toMatchObject({ revision: 1 }));
    act(() => result.current.undo('wi-1', 1));
    await waitFor(() => expect(h.action).toHaveBeenCalledTimes(1));
    act(() => expect(result.current.recordGroups([row], [{ ...row, quantity: 4 }])).toBe(false));
    await act(async () => { finish({ revision: 0, revisionHead: 1, seq: 2 }); await Promise.resolve(); });
    expect(result.current.historyNeedsReload).toBe(true);
    expect(result.current.saveError).toMatch(/re-enter/i);
    const reads = h.query.mock.calls.length;
    act(() => result.current.reloadHistory());
    expect(h.query).toHaveBeenCalledTimes(reads);
    expect(h.record).not.toHaveBeenCalled();
  });

  it('holds history rather than erasing another account’s unconfirmed edit', async () => {
    mailbox('staff-a');
    const h = harness();
    const hook = renderHook(({ user }) => useStoredWork({ trpc: h.trpc, internetMessageId: 'm-1', scope: scope(user) }),
      { initialProps: { user: 'staff-a' } });
    await waitFor(() => expect(hook.result.current.historyCursor).toMatchObject({ revision: 1 }));
    act(() => hook.result.current.recordGroups([row], [{ ...row, quantity: 4 }]));
    h.authenticate('staff-b');
    act(() => mailbox('staff-b'));
    hook.rerender({ user: 'staff-b' });
    await waitFor(() => expect(hook.result.current.historyCursor).toMatchObject({ revision: 1 }));
    act(() => hook.result.current.undo('wi-1', 1));
    await waitFor(() => expect(hook.result.current.historyError).toMatch(/review.*unsaved/i));
    expect(h.action).not.toHaveBeenCalled();
    h.authenticate('staff-a');
    act(() => mailbox('staff-a'));
    hook.rerender({ user: 'staff-a' });
    await waitFor(() => expect(hook.result.current.saveError).toMatch(/review and re-enter/i));
    expect(h.record).not.toHaveBeenCalled();
  });

  it('fails closed against a server with only the older action routes', async () => {
    mailbox('staff-a');
    const h = harness();
    const { ownedPaneAction: omitted, ...workItems } = h.trpc.workItems;
    void omitted;
    const { result } = renderHook(() => useStoredWork({ trpc: { workItems }, internetMessageId: 'm-1', scope: scope('staff-a') }));
    await waitFor(() => expect(result.current.historyCursor).toMatchObject({ revision: 1 }));
    expect(result.current.historyAvailable).toBe(false);
    expect(result.current.resetAvailable).toBe(false);
    act(() => { result.current.acceptUnedited([row]); result.current.undo('wi-1', 1); result.current.resetSection({ type: 'contact' }); });
    expect(h.legacy).not.toHaveBeenCalled();
  });

  it('binds an accept to its original user and mailbox after a same-user mailbox switch', async () => {
    mailbox('staff-a');
    const h = harness();
    let finish!: (value: unknown) => void;
    h.record.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useStoredWork({ trpc: h.trpc, internetMessageId: 'm-1', scope: scope('staff-a') }));
    await waitFor(() => expect(result.current.pane.state).toBe('ready'));
    act(() => { result.current.recordGroups([row], [{ ...row, quantity: 4 }]); result.current.acceptUnedited([row]); });
    expect(h.record).toHaveBeenCalledTimes(1);
    act(() => mailbox('staff-a', 'transport-b'));
    await act(async () => { finish({ value: 4, aiValue: null }); await Promise.resolve(); });
    await waitFor(() => expect(h.action).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'accept', expectedUserId: 'staff-a' }), PINNED));
  });

  it('refuses an accept when cookies switch before the delayed call reaches the server', async () => {
    mailbox('staff-a');
    const h = harness();
    let finish!: (value: unknown) => void;
    h.record.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useStoredWork({ trpc: h.trpc, internetMessageId: 'm-1', scope: scope('staff-a') }));
    await waitFor(() => expect(result.current.pane.state).toBe('ready'));
    act(() => { result.current.recordGroups([row], [{ ...row, quantity: 4 }]); result.current.acceptUnedited([row]); });
    h.authenticate('staff-b');
    await act(async () => { finish({ value: 4, aiValue: null }); await Promise.resolve(); });
    await waitFor(() => expect(h.action).toHaveBeenCalledTimes(1));
    expect(h.action).toHaveBeenCalledWith(expect.objectContaining({ action: 'accept', expectedUserId: 'staff-a' }), PINNED);
    expect(h.actions).toEqual([]);
  });
});
