/** @vitest-environment happy-dom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setMailCacheScope } from '@/lib/mail/mail-cache-scope';
import type { RecordFieldEventInput, StoredWork } from '@/lib/quote-workflow/backend-bind';
import type { StayGroupRequirement } from '@/lib/quote-workflow/types';
import { STORED_LOOKUP_TIMEOUT_MS, useStoredWork, type WorkItemProvenanceMap } from '@/lib/quote-workflow/use-work-item';

type Ready = Extract<StoredWork, { status: 'ready' }> & { fieldProvenance: WorkItemProvenanceMap };
const ROW: StayGroupRequirement = {
  id: 's_1', stayId: 's_1', arrivalDate: '2027-10-20', departureDate: '2027-10-21',
  quantity: 1, adults: 2, childrenPerRoom: null, childrenAges: [], board: 'bb', specialRequests: [], fields: {},
};
const READ: Ready = {
  status: 'ready', kind: 'quote', workItemId: null, workItemStatus: null, extractionId: 'ex-1',
  refs: { s_1: { stayId: 's_1', rowId: null } },
  analysis: { intent: 'quote', groups: [ROW], secondaryAsks: [], alternatives: [] },
  contact: { name: null, company: null, endClient: null, email: null, phone: null },
  language: null, translation: null, fieldProvenance: {},
};
const INITIAL_DIGEST = 'a'.repeat(64);
const digestAt = (seq: number) => seq.toString(16).padStart(64, '0');
const OPENED: Ready = { ...READ, workItemId: 'wi-1', workItemStatus: 'needs_you', revisionSeq: 0, stateDigest: INITIAL_DIGEST };
const CHILD = 'stays[s_1].rows[s_1_row].childrenPerRoom';
const AGES = 'stays[s_1].rows[s_1_row].childAges';
const PINNED = { context: { activeTransportId: 'transport-a' } };
const SCOPE = 'staff:session:transport-a';

function harness() {
  const query = vi.fn(async (_input: { internetMessageId: string }, _opts?: unknown): Promise<StoredWork> => READ);
  const open = vi.fn(async (_input: { internetMessageId: string }, _opts?: unknown): Promise<StoredWork> => OPENED);
  const record = vi.fn(async (input: RecordFieldEventInput, _opts?: unknown) => acknowledge(input));
  const trpc = { workItems: { getByMessage: { query }, open: { mutate: open }, recordEvent: { mutate: record } } };
  return { trpc, query, open, record };
}

function acknowledge(input: RecordFieldEventInput) {
  return {
    aiValue: null, value: input.value ?? null,
    ...(input.expected ? { cursor: {
      extractionId: input.expected.extractionId, seq: input.expected.seq + 1, stateDigest: digestAt(input.expected.seq + 1),
    } } : {}),
  };
}

function mailbox() {
  setMailCacheScope({ userId: 'staff', activeTransportId: 'transport-a' });
}

function markerKeys(): string[] {
  return Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
    .filter((key): key is string => Boolean(key?.startsWith('nava.pending-work-item.v1:')));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setMailCacheScope({ userId: null, activeTransportId: null });
  for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
    const key = sessionStorage.key(i);
    if (key?.startsWith('nava.pending-work-item.v1:')) sessionStorage.removeItem(key);
  }
});

describe('missing work item recovery', () => {
  it('reopens in the original mailbox and waits for child and contact edits to be acknowledged', async () => {
    mailbox();
    const { trpc, open, record } = harness();
    open.mockRejectedValueOnce(new Error('initial open failed'));
    let finish!: () => void;
    record.mockImplementationOnce((input) => new Promise((resolve) => {
      finish = () => resolve(acknowledge(input));
    }));
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null, extractionId: 'ex-1' }));
    act(() => {
      result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]);
      result.current.recordContact('name', 'Guest');
    });
    let settled = false;
    let flushed!: Promise<boolean>;
    act(() => { flushed = result.current.flushEdits(); void flushed.then(() => { settled = true; }); });
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenNthCalledWith(2, { internetMessageId: 'm-1' }, PINNED);
    expect(record).toHaveBeenNthCalledWith(1, expect.objectContaining({ fieldPath: CHILD, value: 0 }), PINNED);
    expect(settled).toBe(false);
    await act(async () => { finish(); expect(await flushed).toBe(true); });
    expect(record.mock.calls.map(([input]) => [input.fieldPath, input.value])).toEqual([
      [CHILD, 0], [AGES, []], ['contact.name', 'Guest'],
    ]);
    expect(record.mock.calls.map(([input]) => input.expected)).toEqual([
      { extractionId: 'ex-1', seq: 0, stateDigest: INITIAL_DIGEST },
      { extractionId: 'ex-1', seq: 1, stateDigest: digestAt(1) },
      { extractionId: 'ex-1', seq: 2, stateDigest: digestAt(2) },
    ]);
    expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-1', contact: { name: 'Guest' } });
    expect(result.current.saveError).toBeNull();
  });

  it('can retry a failed open without discarding the pending edit', async () => {
    mailbox();
    const { trpc, open, record } = harness();
    open.mockRejectedValueOnce(new Error('initial')).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    act(() => result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
    await act(async () => expect(await result.current.flushEdits()).toBe(false));
    expect(record).not.toHaveBeenCalled();
    expect(result.current.saveError).toContain('Retry');
    await act(async () => expect(await result.current.flushEdits()).toBe(true));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ fieldPath: CHILD, value: 0 }), PINNED);
  });

  it('keeps newer changes made while an open is pending', async () => {
    mailbox();
    const { trpc, open, record } = harness();
    let finishOpen!: (value: StoredWork) => void;
    open.mockRejectedValueOnce(new Error('initial')).mockImplementationOnce(() => new Promise((resolve) => { finishOpen = resolve; }));
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    const zero = { ...ROW, childrenPerRoom: 0 };
    act(() => result.current.recordGroups([ROW], [zero]));
    let flushed!: Promise<boolean>;
    act(() => { flushed = result.current.flushEdits(); });
    await act(async () => expect(await result.current.discardUnconfirmedEdits()).toBe(false));
    act(() => result.current.recordGroups([zero], [{ ...zero, childrenPerRoom: 1, childrenAges: [7] }]));
    await act(async () => { finishOpen(OPENED); expect(await flushed).toBe(true); });
    expect(record.mock.calls.map(([input]) => [input.fieldPath, input.value])).toEqual([[CHILD, 1], [AGES, [7]]]);
  });

  it('orders a newer change after an older save already in flight', async () => {
    mailbox();
    const { trpc, open, record } = harness();
    open.mockRejectedValueOnce(new Error('initial'));
    let finish!: () => void;
    record.mockImplementationOnce((input) => new Promise((resolve) => {
      finish = () => resolve(acknowledge(input));
    }));
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    const zero = { ...ROW, childrenPerRoom: 0 };
    act(() => result.current.recordGroups([ROW], [zero]));
    let flushed!: Promise<boolean>;
    act(() => { flushed = result.current.flushEdits(); });
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    act(() => result.current.recordGroups([zero], [{ ...zero, childrenPerRoom: 1, childrenAges: [7] }]));
    await act(async () => { finish(); expect(await flushed).toBe(true); });
    expect(record.mock.calls.map(([input]) => [input.fieldPath, input.value])).toEqual([
      [CHILD, 0], [CHILD, 1], [AGES, [7]],
    ]);
  });

  it('does not replay after a mail switch, even if the original mail is selected again before open completes', async () => {
    mailbox();
    const { trpc, open, record } = harness();
    let finishOpen!: (value: StoredWork) => void;
    open.mockRejectedValueOnce(new Error('initial')).mockImplementationOnce(() => new Promise((resolve) => { finishOpen = resolve; }));
    const { result, rerender } = renderHook(
      ({ messageId }: { messageId: string }) => useStoredWork({ trpc, internetMessageId: messageId, scope: SCOPE }),
      { initialProps: { messageId: 'm-1' } },
    );
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    act(() => result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
    let flushed!: Promise<boolean>;
    act(() => { flushed = result.current.flushEdits(); });
    rerender({ messageId: 'm-2' });
    rerender({ messageId: 'm-1' });
    await act(async () => { finishOpen(OPENED); expect(await flushed).toBe(false); });
    expect(record).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-1' }));
    await act(async () => expect(await result.current.flushEdits()).toBe(true));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ fieldPath: CHILD, value: 0 }), PINNED);
  });

  it('rejects stale edit and flush callbacks after switching away and back', async () => {
    mailbox();
    const { trpc, open, record } = harness();
    open.mockRejectedValueOnce(new Error('initial'));
    const { result, rerender } = renderHook(
      ({ messageId }: { messageId: string }) => useStoredWork({ trpc, internetMessageId: messageId, scope: SCOPE }),
      { initialProps: { messageId: 'm-1' } },
    );
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    const staleEdit = result.current.recordGroups;
    const staleFlush = result.current.flushEdits;
    const zero = { ...ROW, childrenPerRoom: 0 };
    act(() => result.current.recordGroups([ROW], [zero]));
    rerender({ messageId: 'm-2' });
    rerender({ messageId: 'm-1' });
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-1' }));
    act(() => staleEdit([zero], [{ ...zero, childrenPerRoom: 1, childrenAges: [7] }]));
    await act(async () => expect(await staleFlush()).toBe(false));
    await act(async () => expect(await result.current.flushEdits()).toBe(false));
    expect(record).not.toHaveBeenCalled();
    expect(markerKeys()).toHaveLength(1);
  });

  it('does not replay when the active mailbox changes during an open', async () => {
    mailbox();
    const { trpc, open, record } = harness();
    let finishOpen!: (value: StoredWork) => void;
    open.mockRejectedValueOnce(new Error('initial')).mockImplementationOnce(() => new Promise((resolve) => { finishOpen = resolve; }));
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    act(() => result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
    let flushed!: Promise<boolean>;
    act(() => { flushed = result.current.flushEdits(); });
    act(() => setMailCacheScope({ userId: 'staff', activeTransportId: 'transport-b' }));
    await act(async () => { finishOpen(OPENED); expect(await flushed).toBe(false); });
    expect(record).not.toHaveBeenCalled();
  });

  it('holds when the saved read was taken under a different mailbox than the selection scope', async () => {
    setMailCacheScope({ userId: 'staff', activeTransportId: 'transport-b' });
    const { trpc, open, record } = harness();
    open.mockRejectedValueOnce(new Error('initial'));
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    act(() => result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
    await act(async () => expect(await result.current.flushEdits()).toBe(false));
    expect(open).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it('matches the synthetic dates-only alias when the same row exists on reopen', async () => {
    mailbox();
    const { trpc, open, record } = harness();
    const alias: Ready = {
      ...OPENED, refs: { s_1_row: { stayId: 's_1', rowId: 's_1_row' } },
      analysis: { ...OPENED.analysis, groups: [{ ...ROW, id: 's_1_row' }] },
    };
    open.mockRejectedValueOnce(new Error('initial')).mockResolvedValueOnce(alias);
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    act(() => result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
    await act(async () => expect(await result.current.flushEdits()).toBe(true));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ fieldPath: CHILD, value: 0 }), PINNED);
  });

  it('replays a new edit over unchanged seeded provenance', async () => {
    mailbox();
    const { trpc, open, record } = harness();
    open.mockRejectedValueOnce(new Error('initial')).mockResolvedValueOnce({
      ...OPENED, fieldProvenance: {
        [CHILD]: { source: 'ai', value: null }, [AGES]: { source: 'ai', value: [] },
      },
    });
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    act(() => result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
    await act(async () => expect(await result.current.flushEdits()).toBe(true));
    expect(record.mock.calls.map(([input]) => [input.fieldPath, input.value])).toEqual([[CHILD, 0], [AGES, []]]);
  });

  it.each([
    ['new extraction', { ...OPENED, extractionId: 'ex-2' }],
    ['different row', { ...OPENED, refs: { s_1: { stayId: 's_1', rowId: 'different' } } }],
    ['changed case', { ...OPENED, analysis: { ...OPENED.analysis, groups: [{ ...ROW, arrivalDate: '2027-10-22' }] } }],
    ['changed intent', { ...OPENED, analysis: { ...OPENED.analysis, intent: 'other' } }],
    ['staff conflict', { ...OPENED, fieldProvenance: { [CHILD]: { source: 'staff', value: 2 } } }],
    ['unknown conflicting provenance', { ...OPENED, fieldProvenance: { [CHILD]: { source: 'unknown', value: 2 } } }],
    ['other changed staff value', { ...OPENED, fieldProvenance: { 'contact.name': { source: 'staff', value: 'Someone else' } } }],
    ['changed value after undo despite old provenance', {
      ...OPENED,
      analysis: { ...OPENED.analysis, groups: [{ ...ROW, childrenPerRoom: 2 }] },
      fieldProvenance: { [CHILD]: { source: 'ai', value: null } },
    }],
    ['newly saved booking', { ...OPENED, stays: { s_1: { status: 'booked', confirmationNumber: 'LAB-1', screenshotRef: null } } }],
    ['closed work item', { ...OPENED, workItemStatus: 'done' }],
    ['dismissed work item', { ...OPENED, workItemStatus: 'dismissed' }],
  ])('holds an edit on %s', async (_why, changed) => {
    mailbox();
    const { trpc, open, record } = harness();
    open.mockRejectedValueOnce(new Error('initial')).mockResolvedValueOnce(changed as Ready);
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    act(() => result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
    await act(async () => expect(await result.current.flushEdits()).toBe(false));
    expect(record).not.toHaveBeenCalled();
    expect(result.current.saveError).toMatch(/details/i);
  });

  it('does not replay when an older server omits the opened state revision', async () => {
    mailbox();
    const { trpc, open, record } = harness();
    open.mockRejectedValueOnce(new Error('initial')).mockResolvedValueOnce({ ...OPENED, revisionSeq: undefined });
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    act(() => result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
    await act(async () => expect(await result.current.flushEdits()).toBe(false));
    expect(record).not.toHaveBeenCalled();
    expect(result.current.saveError).toMatch(/verif/i);
  });

  it('does not replay when the opened state fingerprint is missing', async () => {
    mailbox();
    const { trpc, open, record } = harness();
    open.mockRejectedValueOnce(new Error('initial')).mockResolvedValueOnce({ ...OPENED, stateDigest: undefined });
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    act(() => result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
    await act(async () => expect(await result.current.flushEdits()).toBe(false));
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ['missing cursor', undefined],
    ['another extraction', { extractionId: 'ex-2', seq: 1, stateDigest: digestAt(1) }],
    ['wrong revision', { extractionId: 'ex-1', seq: 2, stateDigest: digestAt(1) }],
    ['missing state fingerprint', { extractionId: 'ex-1', seq: 1, stateDigest: '' }],
  ] as const)('holds after an unverified save acknowledgment with %s', async (_why, cursor) => {
    mailbox();
    const { trpc, open, record } = harness();
    open.mockRejectedValueOnce(new Error('initial'));
    record.mockImplementationOnce(async (input) => ({ aiValue: null, value: input.value ?? null, cursor }));
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    act(() => result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
    await act(async () => expect(await result.current.flushEdits()).toBe(false));
    expect(record).toHaveBeenCalledTimes(1);
    expect(result.current.saveError).toContain('could not be confirmed');
    await act(async () => expect(await result.current.flushEdits()).toBe(false));
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('stops the remaining replay if another writer changes the revision between events', async () => {
    mailbox();
    const { trpc, open, record } = harness();
    open.mockRejectedValueOnce(new Error('initial'));
    record.mockImplementationOnce(async (input) => acknowledge(input)).mockRejectedValueOnce(new Error('CONFLICT'));
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    act(() => {
      result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]);
      result.current.recordContact('name', 'Guest');
    });
    await act(async () => expect(await result.current.flushEdits()).toBe(false));
    expect(record.mock.calls.map(([input]) => [input.fieldPath, input.expected?.seq])).toEqual([[CHILD, 0], [AGES, 1]]);
    expect(result.current.saveError).toContain('could not be confirmed');
  });

  it('holds an edit with no stored baseline instead of guessing a source row', async () => {
    mailbox();
    const { trpc, query, open, record } = harness();
    query.mockImplementationOnce(() => new Promise(() => undefined));
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    act(() => result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
    await act(async () => expect(await result.current.flushEdits()).toBe(false));
    expect(open).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(result.current.saveError).toMatch(/re-enter/i);
  });

  it('fails closed after an unacknowledged save, including on retry', async () => {
    mailbox();
    const { trpc, open, record } = harness();
    open.mockRejectedValueOnce(new Error('initial'));
    record.mockRejectedValueOnce(new Error('response lost'));
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    act(() => result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
    await act(async () => expect(await result.current.flushEdits()).toBe(false));
    expect(result.current.saveError).toContain('could not be confirmed');
    expect(markerKeys()).toHaveLength(1);
    await act(async () => expect(await result.current.flushEdits()).toBe(false));
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('holds a remounted pane without its baseline until staff discard and reload', async () => {
    mailbox();
    const { trpc, open, record } = harness();
    open.mockRejectedValueOnce(new Error('initial'));
    const accept = vi.fn(async () => ({ accepted: 1 }));
    const move = vi.fn(async () => ({ revision: 0, revisionHead: 0, seq: 0 }));
    const guarded = { workItems: {
      ...trpc.workItems, acceptFields: { mutate: accept }, undoRevision: { mutate: move },
      redoRevision: { mutate: move }, resetSection: { mutate: move },
    } };
    const first = renderHook(() => useStoredWork({ trpc: guarded, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(first.result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    act(() => first.result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
    const marker = markerKeys()[0];
    expect(marker && sessionStorage.getItem(marker)).toBe('1');
    first.unmount();

    // The mailbox is unchanged, but the login session can change while its remembered edit remains in this tab.
    const next = renderHook(() => useStoredWork({ trpc: guarded, internetMessageId: 'm-1', scope: 'staff:new-session:transport-a' }));
    await waitFor(() => expect(next.result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-1' }));
    expect(next.result.current.saveError).toContain('not confirmed');
    expect(next.result.current.historyAvailable).toBe(false);
    expect(next.result.current.resetAvailable).toBe(false);
    act(() => next.result.current.acceptUnedited([ROW]));
    expect(accept).not.toHaveBeenCalled();
    await act(async () => expect(await next.result.current.flushEdits()).toBe(false));
    expect(record).not.toHaveBeenCalled();
    await act(async () => expect(await next.result.current.discardUnconfirmedEdits()).toBe(true));
    expect(next.result.current.historyEpoch).toBe(1);
    expect(next.result.current.saveError).toBeNull();
    expect(marker && sessionStorage.getItem(marker)).toBeNull();
    act(() => next.result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
    await act(async () => expect(await next.result.current.flushEdits()).toBe(true));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ fieldPath: CHILD, value: 0 }), PINNED);
  });

  it('also holds across a pane remount when session storage is unavailable', async () => {
    mailbox();
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      const { trpc, open, record } = harness();
      open.mockRejectedValueOnce(new Error('initial'));
      const first = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-storage', scope: SCOPE }));
      await waitFor(() => expect(first.result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
      act(() => first.result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
      first.unmount();
      const next = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-storage', scope: SCOPE }));
      await waitFor(() => expect(next.result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-1' }));
      await act(async () => expect(await next.result.current.flushEdits()).toBe(false));
      expect(record).not.toHaveBeenCalled();
      await act(async () => expect(await next.result.current.discardUnconfirmedEdits()).toBe(true));
    } finally {
      storage.mockRestore();
    }
  });

  it('does not discard an earlier mail when selection changes during the reload', async () => {
    mailbox();
    const { trpc, query, open, record } = harness();
    open.mockRejectedValueOnce(new Error('initial'));
    const { result, rerender } = renderHook(
      ({ messageId }: { messageId: string }) => useStoredWork({ trpc, internetMessageId: messageId, scope: SCOPE }),
      { initialProps: { messageId: 'm-1' } },
    );
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    act(() => result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
    let finishRead!: (value: StoredWork) => void;
    query.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    let discarded!: Promise<boolean>;
    act(() => { discarded = result.current.discardUnconfirmedEdits(); });
    rerender({ messageId: 'm-2' });
    await act(async () => { finishRead(READ); expect(await discarded).toBe(false); });
    expect(markerKeys()).toHaveLength(1);
    expect(record).not.toHaveBeenCalled();
  });

  it('clears the no-values marker only after all edits are acknowledged', async () => {
    mailbox();
    const { trpc, open } = harness();
    open.mockRejectedValueOnce(new Error('initial'));
    const { result, unmount } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    act(() => result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]));
    expect(markerKeys()).toHaveLength(1);
    await act(async () => expect(await result.current.flushEdits()).toBe(true));
    expect(markerKeys()).toHaveLength(0);
    unmount();
    const again = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await waitFor(() => expect(again.result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-1' }));
    expect(again.result.current.saveError).toBeNull();
    await act(async () => expect(await again.result.current.flushEdits()).toBe(true));
  });

  it('ignores a late initial open after recovery has saved newer edits', async () => {
    mailbox();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { trpc, open, record } = harness();
    let finishInitial!: (value: StoredWork) => void;
    open.mockImplementationOnce(() => new Promise((resolve) => { finishInitial = resolve; }));
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1', scope: SCOPE }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(STORED_LOOKUP_TIMEOUT_MS); });
    expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null });
    act(() => {
      result.current.recordGroups([ROW], [{ ...ROW, childrenPerRoom: 0 }]);
      result.current.recordContact('name', 'Guest');
    });
    await act(async () => expect(await result.current.flushEdits()).toBe(true));
    await act(async () => { finishInitial({ ...OPENED, workItemId: 'old-item' }); await Promise.resolve(); });
    expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-1', contact: { name: 'Guest' } });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ fieldPath: CHILD, value: 0 }), PINNED);
  });
});
