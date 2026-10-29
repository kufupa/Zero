/** @vitest-environment happy-dom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setMailCacheScope } from '@/lib/mail/mail-cache-scope';
import { isCurrentWorkSelection, storedWorkOwnerMatches, storedWorkScope } from '@/lib/quote-workflow/stored-work-scope';
import { paneEditKey, recalledPaneEdits, rememberPaneEdits, resetPaneEditsForTests } from '@/lib/quote-workflow/pane-edits';
import { useStoredWork } from '@/lib/quote-workflow/use-work-item';
import type { StoredWork } from '@/lib/quote-workflow/backend-bind';

const HEADER = '<shared@example.test>';
const TRANSPORT = 'transport-a';
const SCOPE = `staff:session:${TRANSPORT}`;

function ready(row: string, workItemId: string): StoredWork {
  return {
    status: 'ready', sourceMessageId: row, kind: 'quote', workItemId, workItemStatus: 'needs_you',
    extractionId: `extract-${row}`, refs: {},
    analysis: { intent: 'quote', groups: [], secondaryAsks: [], alternatives: [] },
    contact: { name: null, company: null, endClient: null, email: null, phone: null },
    language: null, translation: null,
  };
}

function scope(entryId: string, user = 'staff', session = 'session'): string | null {
  return storedWorkScope(`${user}:${session}:${TRANSPORT}`, TRANSPORT, { storeId: TRANSPORT, entryId }, user);
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  resetPaneEditsForTests();
  vi.useRealTimers();
  setMailCacheScope({ userId: null, activeTransportId: null });
});

describe('web selected-row stored work', () => {
  it('rejects a stale binding for another entry even when both messages share a header', () => {
    const binding = { transportId: TRANSPORT, mailboxEmail: 'desk@example.test', storeId: TRANSPORT,
      folderEntryId: 'thread', entryId: 'row-a', internetMessageId: HEADER, selectionEpoch: 1, scopeEpoch: 1 };
    const email = { storeId: TRANSPORT, folderEntryId: 'thread', entryId: 'row-a', internetMessageId: HEADER };
    expect(isCurrentWorkSelection(binding, email, { selectionEpoch: 1, scopeEpoch: 1 })).toBe(true);
    expect(isCurrentWorkSelection(binding, { ...email, entryId: 'row-b' }, { selectionEpoch: 1, scopeEpoch: 1 })).toBe(false);
    expect(isCurrentWorkSelection(binding, { ...email, storeId: 'other' }, { selectionEpoch: 1, scopeEpoch: 1 })).toBe(false);
    expect(isCurrentWorkSelection(binding, email, { selectionEpoch: 2, scopeEpoch: 1 })).toBe(false);
    expect(isCurrentWorkSelection(binding, email, { selectionEpoch: 1, scopeEpoch: 2 })).toBe(false);
  });
  it('uses collision-safe entry identity while retaining the mailbox suffix', () => {
    const first = storedWorkScope(SCOPE, TRANSPORT, { storeId: 'a:b', entryId: 'c' }, 'staff');
    const second = storedWorkScope(SCOPE, TRANSPORT, { storeId: 'a', entryId: 'b:c' }, 'staff');
    expect(first).not.toEqual(second);
    expect(first?.startsWith('staff:')).toBe(true);
    expect(first?.endsWith(`:${TRANSPORT}`)).toBe(true);
    expect(scope('row-a')).toEqual(scope('row-a'));
    expect(storedWorkScope(SCOPE, TRANSPORT, { entryId: 'row-a' }, null)).toBeNull();
    const owner = { userId: 'staff', activeTransportId: TRANSPORT };
    expect(storedWorkOwnerMatches(scope('row-a'), 'row-a', owner)).toBe(true);
    expect(storedWorkOwnerMatches(scope('row-a'), 'row-b', owner)).toBe(false);
    expect(storedWorkOwnerMatches(scope('row-a'), 'row-a', { ...owner, userId: 'other' })).toBe(false);
    expect(storedWorkOwnerMatches(scope('row-a'), 'row-a', { ...owner, activeTransportId: null })).toBe(false);
  });

  it('isolates remembered rows for messages with the same header without deleting legacy edits', () => {
    const legacy = paneEditKey(TRANSPORT, HEADER);
    const first = paneEditKey(TRANSPORT, HEADER, 'row-a', 'staff');
    const second = paneEditKey(TRANSPORT, HEADER, 'row-b', 'staff');
    const otherUser = paneEditKey(TRANSPORT, HEADER, 'row-a', 'other');
    const groups = [{ id: 'stay-a', childrenAges: [], board: 'unknown' as const,
      quantity: 1, specialRequests: [], fields: {} }];
    rememberPaneEdits(legacy, groups);
    rememberPaneEdits(first, groups);
    expect(first).not.toEqual(second);
    expect(recalledPaneEdits(second)).toBeNull();
    expect(recalledPaneEdits(otherUser)).toBeNull();
    expect(paneEditKey(TRANSPORT, HEADER, 'row-a', null)).toBe('');
    expect(recalledPaneEdits(legacy)).toEqual(groups);
  });

  it('does not apply a late A read after selecting B with the same header', async () => {
    setMailCacheScope({ userId: 'staff', activeTransportId: TRANSPORT });
    let finishA!: (value: StoredWork) => void;
    const query = vi.fn(({ expectedMessageId }: { expectedMessageId?: string }) =>
      expectedMessageId === 'row-a'
        ? new Promise<StoredWork>((resolve) => { finishA = resolve; })
        : Promise.resolve<StoredWork>({ status: 'failed', hold: true, reason: 'Selected source is unavailable.' }));
    const open = vi.fn();
    const trpc = { workItems: { getByMessage: { query }, open: { mutate: open } } };
    const { result, rerender } = renderHook(({ entryId }) => useStoredWork({
      trpc, internetMessageId: HEADER, expectedMessageId: entryId, scope: scope(entryId),
    }), { initialProps: { entryId: 'row-a' } });
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    rerender({ entryId: 'row-b' });
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'failed', hold: true }));
    await act(async () => { finishA(ready('row-a', 'work-a')); await Promise.resolve(); });
    expect(result.current.pane).toMatchObject({ state: 'failed', hold: true });
    expect(query).toHaveBeenLastCalledWith(
      { internetMessageId: HEADER, expectedMessageId: 'row-b' }, { context: { activeTransportId: TRANSPORT } },
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('does not refresh a different selected row after an owned history action finishes', async () => {
    setMailCacheScope({ userId: 'staff', activeTransportId: TRANSPORT });
    let finish!: (value: unknown) => void;
    const query = vi.fn(async ({ expectedMessageId }: { expectedMessageId?: string }) =>
      ready(expectedMessageId!, expectedMessageId === 'row-a' ? 'work-a' : 'work-b'));
    const action = vi.fn(() => new Promise<unknown>((resolve) => { finish = resolve; }));
    const cursor = vi.fn(async () => ({ revision: 1, revisionHead: 1, seq: 1 }));
    const trpc = { workItems: { getByMessage: { query }, ownedPaneAction: { mutate: action },
      revisionCursor: { query: cursor } } };
    const { result, rerender } = renderHook(({ entryId }) => useStoredWork({
      trpc, internetMessageId: HEADER, expectedMessageId: entryId, scope: scope(entryId),
    }), { initialProps: { entryId: 'row-a' } });
    await waitFor(() => expect(result.current.historyCursor?.revision).toBe(1));
    act(() => result.current.undo('work-a', 1));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledWith(expect.objectContaining({
      action: 'undo', workItemId: 'work-a', expectedUserId: 'staff',
    }), { context: { activeTransportId: TRANSPORT } });
    rerender({ entryId: 'row-b' });
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'work-b' }));
    const reads = query.mock.calls.length;
    await act(async () => { finish({ revision: 0, revisionHead: 1, seq: 2 }); await Promise.resolve(); });
    expect(query).toHaveBeenCalledTimes(reads);
    expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'work-b' });
    expect(result.current.historyEpoch).toBe(0);
  });

  it.each([
    { userId: 'other', activeTransportId: TRANSPORT },
    { userId: 'staff', activeTransportId: 'other-transport' },
  ])('does not dispatch stale owned history after the web scope changes', async (nextOwner) => {
    setMailCacheScope({ userId: 'staff', activeTransportId: TRANSPORT });
    const query = vi.fn(async () => ready('row-a', 'work-a'));
    const action = vi.fn();
    const cursor = vi.fn(async () => ({ revision: 1, revisionHead: 1, seq: 1 }));
    const { result } = renderHook(() => useStoredWork({
      trpc: { workItems: { getByMessage: { query }, ownedPaneAction: { mutate: action },
        revisionCursor: { query: cursor } } }, internetMessageId: HEADER,
      expectedMessageId: 'row-a', scope: scope('row-a'),
    }));
    await waitFor(() => expect(result.current.historyCursor?.revision).toBe(1));
    const staleUndo = result.current.undo;
    act(() => setMailCacheScope(nextOwner));
    act(() => staleUndo('work-a', 1));
    expect(action).not.toHaveBeenCalled();
  });

  it('keeps an A edit on A, and retains a failed save for retry after selecting B', async () => {
    setMailCacheScope({ userId: 'staff', activeTransportId: TRANSPORT });
    const query = vi.fn(async ({ expectedMessageId }: { expectedMessageId?: string }) =>
      ready(expectedMessageId!, expectedMessageId === 'row-a' ? 'work-a' : 'work-b'));
    const record = vi.fn(async (_input: unknown, _opts?: unknown) => { throw new Error('offline'); });
    const trpc = { workItems: { getByMessage: { query }, recordEvent: { mutate: record }, recordOwnedEvent: { mutate: record } } };
    const { result, rerender } = renderHook(({ entryId }) => useStoredWork({
      trpc, internetMessageId: HEADER, expectedMessageId: entryId, scope: scope(entryId),
    }), { initialProps: { entryId: 'row-a' } });
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'work-a' }));
    rerender({ entryId: 'row-a' });
    expect(query).toHaveBeenCalledTimes(1);
    act(() => result.current.recordContact('name', 'Edited A'));
    rerender({ entryId: 'row-b' });
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'work-b' }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: 'work-a', fieldPath: 'contact.name', value: 'Edited A',
    }), { context: { activeTransportId: TRANSPORT } });
    expect(result.current.pane.state === 'ready' && result.current.pane.contact.name).toBeNull();
    await waitFor(() => expect(result.current.saveFailed).toBe(true), { timeout: 3000 });
    record.mockResolvedValue({} as never);
    act(() => result.current.retrySave());
    await waitFor(() => expect(record).toHaveBeenLastCalledWith(expect.objectContaining({
      workItemId: 'work-a', fieldPath: 'contact.name', value: 'Edited A',
    }), { context: { activeTransportId: TRANSPORT } }));
  });

  it('retains a pre-existing unconfirmed-edit marker when the row scope changes', async () => {
    setMailCacheScope({ userId: 'staff', activeTransportId: TRANSPORT });
    sessionStorage.setItem(`nava.pending-work-item.v1:${encodeURIComponent(`${TRANSPORT}\n${HEADER}`)}`, '1');
    const trpc = { workItems: { getByMessage: { query: async () => ready('row-b', 'work-b') } } };
    const { result } = renderHook(() => useStoredWork({
      trpc, internetMessageId: HEADER, expectedMessageId: 'row-b', scope: scope('row-b'),
    }));
    await waitFor(() => expect(result.current.pane.state).toBe('ready'));
    expect(result.current.saveError).toMatch(/not assigned to this email/);
    expect(result.current.unattributedRecovery).toBe(true);
    expect(await result.current.discardUnconfirmedEdits()).toBe(false);
    expect(sessionStorage.length).toBeGreaterThan(0);
  });

  it('keeps owned recovery markers across session renewal and isolated from another staff user', async () => {
    let stored: StoredWork = { ...ready('row-a', 'work-a'), workItemId: null } as StoredWork;
    const trpc = { workItems: { getByMessage: { query: async () => stored } } };
    setMailCacheScope({ userId: 'staff', activeTransportId: TRANSPORT });
    const original = renderHook(() => useStoredWork({
      trpc, internetMessageId: HEADER, expectedMessageId: 'row-a', scope: scope('row-a'),
    }));
    await waitFor(() => expect(original.result.current.pane.state).toBe('ready'));
    act(() => original.result.current.recordContact('name', 'Unconfirmed'));
    const storageKey = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i))
      .find((key) => key?.startsWith('nava.pending-work-item.v1:'));
    expect(storageKey).toBeTruthy();
    original.unmount();
    stored = ready('row-a', 'work-a');
    const first = renderHook(() => useStoredWork({
      trpc, internetMessageId: HEADER, expectedMessageId: 'row-a', scope: scope('row-a', 'staff', 'renewed'),
    }));
    await waitFor(() => expect(first.result.current.pane.state).toBe('ready'));
    expect(first.result.current.saveError).toMatch(/Earlier changes were not confirmed/);
    expect(first.result.current.unattributedRecovery).toBe(false);
    first.unmount();
    stored = ready('row-b', 'work-b');
    const nextRow = renderHook(() => useStoredWork({
      trpc, internetMessageId: HEADER, expectedMessageId: 'row-b', scope: scope('row-b'),
    }));
    await waitFor(() => expect(nextRow.result.current.pane.state).toBe('ready'));
    expect(nextRow.result.current.saveError).toBeNull();
    nextRow.unmount();
    stored = ready('row-a', 'work-a');
    act(() => setMailCacheScope({ userId: 'other', activeTransportId: TRANSPORT }));
    const second = renderHook(() => useStoredWork({
      trpc, internetMessageId: HEADER, expectedMessageId: 'row-a', scope: scope('row-a', 'other'),
    }));
    await waitFor(() => expect(second.result.current.pane.state).toBe('ready'));
    expect(second.result.current.saveError).toBeNull();
    let discarded = false;
    await act(async () => { discarded = await second.result.current.discardUnconfirmedEdits(); });
    expect(discarded).toBe(true);
    expect(sessionStorage.getItem(storageKey!)).toBe('1');
  });

  it('waits for a signed-in scope before looking up the selected web row', async () => {
    setMailCacheScope({ userId: null, activeTransportId: TRANSPORT });
    const query = vi.fn(async () => ready('row-a', 'work-a'));
    const { result, rerender } = renderHook(({ selectedScope }: { selectedScope: string | null }) => useStoredWork({
      trpc: { workItems: { getByMessage: { query } } }, internetMessageId: HEADER,
      expectedMessageId: 'row-a', scope: selectedScope,
    }), { initialProps: { selectedScope: null as string | null } });
    expect(result.current.pane).toMatchObject({ state: 'loading' });
    expect(query).not.toHaveBeenCalled();
    setMailCacheScope({ userId: 'staff', activeTransportId: TRANSPORT });
    rerender({ selectedScope: scope('row-a') });
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'work-a' }));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('waits for the exact signed-in mailbox scope before looking up a web row', async () => {
    setMailCacheScope({ userId: 'staff', activeTransportId: null });
    const query = vi.fn(async () => ready('row-a', 'work-a'));
    const undo = vi.fn();
    const redo = vi.fn();
    const revisionCursor = vi.fn(async () => ({ revision: 1, revisionHead: 1, seq: 1 }));
    const { result } = renderHook(() => useStoredWork({
      trpc: { workItems: { getByMessage: { query }, undoRevision: { mutate: undo }, redoRevision: { mutate: redo },
        revisionCursor: { query: revisionCursor } } }, internetMessageId: HEADER,
      expectedMessageId: 'row-a', scope: scope('row-a'),
    }));
    expect(result.current.pane).toMatchObject({ state: 'loading' });
    expect(query).not.toHaveBeenCalled();
    act(() => setMailCacheScope({ userId: 'other', activeTransportId: TRANSPORT }));
    expect(result.current.pane).toMatchObject({ state: 'loading' });
    expect(query).not.toHaveBeenCalled();
    act(() => setMailCacheScope({ userId: 'staff', activeTransportId: 'other-transport' }));
    expect(result.current.pane).toMatchObject({ state: 'loading' });
    expect(query).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    act(() => setMailCacheScope({ userId: 'staff', activeTransportId: TRANSPORT }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'work-a' }));
    expect(query).toHaveBeenCalledWith(
      { internetMessageId: HEADER, expectedMessageId: 'row-a' }, { context: { activeTransportId: TRANSPORT } },
    );
    await waitFor(() => expect(result.current.historyCursor?.revision).toBe(1));
    const staleUndo = result.current.undo;
    act(() => setMailCacheScope({ userId: 'other', activeTransportId: TRANSPORT }));
    act(() => staleUndo('work-a', 1));
    expect(undo).not.toHaveBeenCalled();
  });

  it('discards a late read if the signed-in owner changes before it returns', async () => {
    setMailCacheScope({ userId: 'staff', activeTransportId: TRANSPORT });
    let finish!: (value: StoredWork) => void;
    const query = vi.fn(() => new Promise<StoredWork>((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useStoredWork({
      trpc: { workItems: { getByMessage: { query } } }, internetMessageId: HEADER,
      expectedMessageId: 'row-a', scope: scope('row-a'),
    }));
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    act(() => setMailCacheScope({ userId: 'other', activeTransportId: TRANSPORT }));
    await act(async () => { finish(ready('row-a', 'work-a')); await Promise.resolve(); });
    expect(result.current.pane).toMatchObject({ state: 'loading' });
  });

  it('holds a selected web row if the stored-read route is missing after scope resolves', () => {
    setMailCacheScope({ userId: 'staff', activeTransportId: TRANSPORT });
    const { result } = renderHook(() => useStoredWork({
      trpc: { workItems: {} }, internetMessageId: HEADER, expectedMessageId: 'row-a', scope: scope('row-a'),
    }));
    expect(result.current.pane).toMatchObject({ state: 'failed', hold: true });
  });

  it('holds a selected web row when the stored read identifies another row', async () => {
    setMailCacheScope({ userId: 'staff', activeTransportId: TRANSPORT });
    const query = vi.fn(async () => ready('row-a', 'work-a'));
    const { result } = renderHook(() => useStoredWork({
      trpc: { workItems: { getByMessage: { query } } }, internetMessageId: HEADER,
      expectedMessageId: 'row-b', scope: scope('row-b'),
    }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'failed', hold: true }));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('publishes a mismatched source hold when discarding changes refreshes the selected web row', async () => {
    setMailCacheScope({ userId: 'staff', activeTransportId: TRANSPORT });
    let source = ready('row-a', 'work-a');
    const query = vi.fn(async () => source);
    const { result } = renderHook(() => useStoredWork({
      trpc: { workItems: { getByMessage: { query } } }, internetMessageId: HEADER,
      expectedMessageId: 'row-a', scope: scope('row-a'),
    }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'work-a' }));
    source = ready('row-b', 'work-b');
    await act(async () => expect(await result.current.discardUnconfirmedEdits()).toBe(false));
    expect(result.current.pane).toMatchObject({ state: 'failed', hold: true });
    expect(result.current.historyNeedsReload).toBe(true);
  });

  it('ignores a stale discard hold after switching away and back to the same web row', async () => {
    setMailCacheScope({ userId: 'staff', activeTransportId: TRANSPORT });
    let finishRead!: (value: StoredWork) => void;
    let delayNext = false;
    const query = vi.fn(({ expectedMessageId }: { expectedMessageId?: string }) => {
      if (expectedMessageId === 'row-a' && delayNext) {
        delayNext = false;
        return new Promise<StoredWork>((resolve) => { finishRead = resolve; });
      }
      return Promise.resolve(ready(expectedMessageId!, expectedMessageId === 'row-a' ? 'work-a' : 'work-b'));
    });
    const trpc = { workItems: { getByMessage: { query } } };
    const { result, rerender } = renderHook(({ entryId }) => useStoredWork({
      trpc, internetMessageId: HEADER, expectedMessageId: entryId, scope: scope(entryId),
    }), { initialProps: { entryId: 'row-a' } });
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'work-a' }));
    delayNext = true;
    let discard!: Promise<boolean>;
    act(() => { discard = result.current.discardUnconfirmedEdits(); });
    await waitFor(() => expect(finishRead).toBeTypeOf('function'));
    rerender({ entryId: 'row-b' });
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'work-b' }));
    rerender({ entryId: 'row-a' });
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'work-a' }));
    await act(async () => {
      finishRead({ status: 'failed', hold: true, reason: 'Selected source is unavailable.' });
      expect(await discard).toBe(false);
    });
    expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'work-a' });
  });

  it('does not apply a discard source hold after the signed-in user changes', async () => {
    setMailCacheScope({ userId: 'staff', activeTransportId: TRANSPORT });
    let finishRead!: (value: StoredWork) => void;
    let delayNext = false;
    const query = vi.fn(() => delayNext
      ? new Promise<StoredWork>((resolve) => { finishRead = resolve; })
      : Promise.resolve(ready('row-a', 'work-a')));
    const { result } = renderHook(() => useStoredWork({
      trpc: { workItems: { getByMessage: { query } } }, internetMessageId: HEADER,
      expectedMessageId: 'row-a', scope: scope('row-a'),
    }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'work-a' }));
    delayNext = true;
    let discard!: Promise<boolean>;
    act(() => { discard = result.current.discardUnconfirmedEdits(); });
    await waitFor(() => expect(finishRead).toBeTypeOf('function'));
    act(() => setMailCacheScope({ userId: 'other', activeTransportId: TRANSPORT }));
    await act(async () => {
      finishRead({ status: 'failed', hold: true, reason: 'Selected source is unavailable.' });
      expect(await discard).toBe(false);
    });
    expect(result.current.pane).toMatchObject({ state: 'loading' });
  });
});
