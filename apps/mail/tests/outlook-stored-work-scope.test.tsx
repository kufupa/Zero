/** @vitest-environment happy-dom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setMailCacheScope } from '@/lib/mail/mail-cache-scope';
import type { StoredWork } from '@/lib/quote-workflow/backend-bind';
import type { StayGroupRequirement } from '@/lib/quote-workflow/types';
import { useStoredWork } from '@/lib/quote-workflow/use-work-item';

const row: StayGroupRequirement = {
  id: 'r1', stayId: 's1', arrivalDate: '2027-10-20', departureDate: '2027-10-21', quantity: 1,
  adults: 2, childrenAges: [], board: 'bb', specialRequests: [], fields: {},
};
function ready(workItemId: string): Extract<StoredWork, { status: 'ready' }> {
  return { status: 'ready', kind: 'quote', workItemId, workItemStatus: 'needs_you', extractionId: 'ex-1',
    refs: { r1: { stayId: 's1', rowId: 'r1' } },
    analysis: { intent: 'quote', groups: [row], secondaryAsks: [], alternatives: [] },
    contact: { name: null, company: null, endClient: null, email: null, phone: null }, language: null, translation: null };
}
const scope = (user = 'staff-a', transport = 'transport-a') => `${user}:session:${transport}`;
const mailbox = (userId: string | null, activeTransportId: string | null) => setMailCacheScope({ userId, activeTransportId });

afterEach(() => {
  cleanup();
  mailbox(null, null);
  sessionStorage.clear();
});

describe('Outlook stored-work mailbox scope', () => {
  it.each([
    ['not loaded', null, null],
    ['previous owner', 'staff-b', 'transport-a'],
    ['previous mailbox', 'staff-a', 'transport-b'],
  ])('waits when the cache still has %s, then reads when it matches', async (_label, user, transport) => {
    mailbox(user, transport);
    const query = vi.fn(async () => ready('wi-a'));
    const trpc = { workItems: { getByMessage: { query } } };
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: scope(),
      expectedMailbox: { userId: 'staff-a', transportId: 'transport-a' } }));
    expect(result.current.pane.state).toBe('loading');
    expect(query).not.toHaveBeenCalled();
    act(() => mailbox('staff-a', 'transport-a'));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-a' }));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith({ internetMessageId: 'm-1' }, { context: { activeTransportId: 'transport-a' } });
  });

  it('compares the full user ID instead of trusting a matching scope prefix', async () => {
    mailbox('staff', 'transport-a');
    const query = vi.fn(async () => ready('wi-a'));
    const trpc = { workItems: { getByMessage: { query } } };
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: scope('staff:other'),
      expectedMailbox: { userId: 'staff:other', transportId: 'transport-a' } }));
    expect(result.current.pane.state).toBe('loading');
    expect(query).not.toHaveBeenCalled();
    act(() => mailbox('staff:other', 'transport-a'));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-a' }));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a read if two owners produce the same serialized scope', async () => {
    mailbox('staff', 'transport-a');
    const query = vi.fn().mockResolvedValueOnce(ready('wi-a')).mockResolvedValue(ready('wi-b'));
    const trpc = { workItems: { getByMessage: { query } } };
    const collidingScope = 'staff:other:session:transport-a';
    const hook = renderHook(({ owner }) => useStoredWork({ trpc, internetMessageId: 'm-1', scope: collidingScope,
      expectedMailbox: { userId: owner, transportId: 'transport-a' } }), { initialProps: { owner: 'staff' } });
    await waitFor(() => expect(hook.result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-a' }));
    act(() => { mailbox('staff:other', 'transport-a'); hook.rerender({ owner: 'staff:other' }); });
    expect(hook.result.current.pane).not.toMatchObject({ state: 'ready', workItemId: 'wi-a' });
    await waitFor(() => expect(hook.result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-b' }));
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('drops a late old-owner read while the selected scope and cache catch up', async () => {
    mailbox('staff-a', 'transport-a');
    let finishOld!: (value: StoredWork) => void;
    const query = vi.fn()
      .mockImplementationOnce(() => new Promise<StoredWork>((resolve) => { finishOld = resolve; }))
      .mockResolvedValue(ready('wi-b'));
    const trpc = { workItems: { getByMessage: { query } } };
    const hook = renderHook(({ owner }) => useStoredWork({ trpc, internetMessageId: 'm-1', scope: scope(owner),
      expectedMailbox: { userId: owner, transportId: 'transport-a' } }),
      { initialProps: { owner: 'staff-a' } });
    expect(query).toHaveBeenCalledTimes(1);
    act(() => mailbox('staff-b', 'transport-a'));
    expect(hook.result.current.pane.state).toBe('loading');
    expect(query).toHaveBeenCalledTimes(1);
    hook.rerender({ owner: 'staff-b' });
    await waitFor(() => expect(hook.result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-b' }));
    await act(async () => { finishOld(ready('wi-a')); await Promise.resolve(); });
    expect(hook.result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-b' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not publish a late history refresh after the cache owner changes', async () => {
    mailbox('staff-a', 'transport-a');
    let finishRefresh!: (value: StoredWork) => void;
    const query = vi.fn().mockResolvedValueOnce(ready('wi-a'))
      .mockImplementationOnce(() => new Promise<StoredWork>((resolve) => { finishRefresh = resolve; }))
      .mockResolvedValue(ready('wi-fresh'));
    const trpc = { workItems: { getByMessage: { query } } };
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: scope(),
      expectedMailbox: { userId: 'staff-a', transportId: 'transport-a' } }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-a' }));
    act(() => result.current.reloadHistory());
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    act(() => mailbox('staff-b', 'transport-a'));
    await act(async () => { finishRefresh(ready('wi-stale')); await Promise.resolve(); });
    expect(result.current.pane.state).toBe('loading');
    act(() => mailbox('staff-a', 'transport-a'));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-fresh' }));
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('flushes a same-user edit to its original mailbox while switching mailboxes', async () => {
    mailbox('staff-a', 'transport-a');
    const query = vi.fn(async () => ready('wi-a'));
    const record = vi.fn(async (_input: unknown, _opts?: unknown) => ({ aiValue: null, value: null }));
    const trpc = { workItems: { getByMessage: { query }, recordEvent: { mutate: record }, recordOwnedEvent: { mutate: record } } };
    const hook = renderHook(({ transport }) => useStoredWork({ trpc, internetMessageId: 'm-1',
      scope: scope('staff-a', transport), expectedMailbox: { userId: 'staff-a', transportId: transport } }), { initialProps: { transport: 'transport-a' } });
    await waitFor(() => expect(hook.result.current.pane.state).toBe('ready'));
    act(() => hook.result.current.recordGroups([row], [{ ...row, quantity: 4 }]));
    act(() => mailbox('staff-a', 'transport-b'));
    hook.rerender({ transport: 'transport-b' });
    await waitFor(() => expect(hook.result.current.pane.state).toBe('ready'));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ workItemId: 'wi-a', value: 4 }),
      { context: { activeTransportId: 'transport-a' } });
    expect(query).toHaveBeenLastCalledWith({ internetMessageId: 'm-1' }, { context: { activeTransportId: 'transport-b' } });
  });
});
