/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuoteWorkflowPanel } from '@/components/quote-workflow/quote-workflow-panel';
import { DRAFT_GROUP_ID, initialQuoteSession, reduceQuoteSession } from '@/lib/quote-workflow/session';
import type { StoredWork } from '@/lib/quote-workflow/backend-bind';
import { setMailCacheScope, transportForCall } from '@/lib/mail/mail-cache-scope';
import type { QuoteAnalysis, QuoteSession, StayGroupRequirement } from '@/lib/quote-workflow/types';
import {
  fieldEventsBetween,
  STORED_LOOKUP_TIMEOUT_MS,
  storedDecision,
  useStoredWork,
  WORK_EVENT_DEBOUNCE_MS,
  WORK_EVENT_RETRY_MS,
  type StoredPane,
} from '@/lib/quote-workflow/use-work-item';

type Ready = Extract<StoredWork, { status: 'ready' }>;

const ANALYSIS = { intent: 'quote', groups: [], secondaryAsks: [], alternatives: [] } as unknown as Ready['analysis'];

const NO_CONTACT = { name: null, company: null, endClient: null, email: null, phone: null };

const READY: Ready = {
  status: 'ready',
  kind: 'quote',
  workItemId: 'wi-1',
  workItemStatus: 'needs_you',
  extractionId: 'ex-1',
  refs: {
    g1: { stayId: 'st-1', rowId: 'rw-1' },
    g2: { stayId: 'st-1', rowId: 'rw-2' },
    g3: { stayId: 'st-2', rowId: null },
  },
  analysis: ANALYSIS,
  contact: NO_CONTACT,
  language: null,
  translation: null,
};

/** One pane row. Stored rows carry the read's stay id, as the stored analysis gives them. */
function row(id: string, stayId: string | undefined, values: Partial<StayGroupRequirement> = {}): StayGroupRequirement {
  return {
    id,
    stayId,
    arrivalDate: '2026-10-12',
    departureDate: '2026-10-14',
    quantity: 1,
    adults: 2,
    childrenAges: [],
    board: 'bb',
    specialRequests: [],
    fields: {},
    ...values,
  };
}

const G1 = row('g1', 'st-1');
const G2 = row('g2', 'st-1');
const G3 = row('g3', 'st-2', { arrivalDate: '2026-11-01', departureDate: '2026-11-03' });

function fakeTrpc(lookup: () => unknown) {
  const query = vi.fn(async (_input: unknown) => lookup());
  const mutate = vi.fn(async (_input: unknown, _opts?: unknown) => ({ aiValue: null, value: null }));
  return { trpc: { workItems: { getByMessage: { query }, recordEvent: { mutate } } }, query, mutate };
}

describe('storedDecision', () => {
  const ready: StoredPane = {
    state: 'ready',
    analysis: ANALYSIS,
    kind: 'quote',
    workItemStatus: 'needs_you',
    workItemId: 'wi-1',
    contact: NO_CONTACT,
    language: null,
    translation: null,
  };

  it('reads live whenever the person asked for a treat-as or a staff note', () => {
    expect(storedDecision(ready, true)).toEqual({ kind: 'live' });
    expect(storedDecision({ state: 'loading' }, true)).toEqual({ kind: 'live' });
  });

  it('waits while the stored read is loading, so the live read does not start twice', () => {
    expect(storedDecision({ state: 'loading' }, false)).toEqual({ kind: 'wait' });
  });

  it('uses the stored analysis when ready and the stored reason when failed', () => {
    expect(storedDecision(ready, false)).toEqual({ kind: 'ready', analysis: ANALYSIS });
    expect(storedDecision({ state: 'failed', reason: 'The read timed out.' }, false)).toEqual({
      kind: 'failed',
      reason: 'The read timed out.',
    });
  });

  it('reads live when nothing is stored', () => {
    expect(storedDecision({ state: 'reading' }, false)).toEqual({ kind: 'live' });
  });
});

describe('fieldEventsBetween', () => {
  it('maps a row edit to its stable stay and row ids, and a stay date to the stay', () => {
    expect(
      fieldEventsBetween(READY.refs, [G1, G2], [row('g1', 'st-1', { arrivalDate: '2026-10-11', quantity: 2, board: 'dinner_bb' }), G2]),
    ).toEqual([
      { path: 'stays[st-1].requested.arrival', value: '2026-10-11' },
      { path: 'stays[st-1].rows[rw-1].count', value: 2 },
      { path: 'stays[st-1].rows[rw-1].board', value: 'dbb' },
    ]);
  });

  it('persists both stay totals once and preserves an explicit zero when clearing to unknown', () => {
    const withTotals = [
      row('g1', 'st-1', { adultsTotal: 5, childrenTotal: 0 }),
      row('g2', 'st-1', { adultsTotal: 5, childrenTotal: 0 }),
    ];
    expect(fieldEventsBetween(READY.refs, [G1, G2], withTotals)).toEqual([
      { path: 'stays[st-1].totalAdults', value: 5 },
      { path: 'stays[st-1].totalChildren', value: 0 },
    ]);
    expect(fieldEventsBetween(READY.refs, withTotals, [G1, G2])).toEqual([
      { path: 'stays[st-1].totalAdults', value: null },
      { path: 'stays[st-1].totalChildren', value: null },
    ]);
  });

  it('does not clear stay totals when a replacement row remains after the original is removed', () => {
    const original = row('g1', 'st-1', { adultsTotal: 5, childrenTotal: 0 });
    const session = { ...initialQuoteSession(), groups: [original] };
    const added = reduceQuoteSession(session, { type: 'add_row', stayId: 'st-1', token: 'replacement' });
    expect(added.groups[1]).toMatchObject({ adultsTotal: 5, childrenTotal: 0 });
    const replaced = reduceQuoteSession(added, { type: 'remove_row', groupId: 'g1' });

    expect(fieldEventsBetween(READY.refs, added.groups, replaced.groups)).toEqual([
      { path: 'stays[st-1].rows[rw-1].removed', value: true },
    ]);
  });

  it('logs a stay with no row by its dates and its own row, and an unknown board or empty date as null', () => {
    expect(fieldEventsBetween(READY.refs, [G3], [{ ...G3, departureDate: '', quantity: 3 }])).toEqual([
      { path: 'stays[st-2].requested.departure', value: null },
      { path: 'stays[st-2].rows[st-2_row].count', value: 3 },
    ]);
    // Every later edit to that stay's room controls lands on the same row.
    expect(fieldEventsBetween(READY.refs, [G3], [{ ...G3, roomPreference: 'Family', adults: 3 }])).toEqual([
      { path: 'stays[st-2].rows[st-2_row].adults', value: 3 },
      { path: 'stays[st-2].rows[st-2_row].roomType', value: 'Family' },
    ]);
    expect(fieldEventsBetween(READY.refs, [G2], [{ ...G2, board: 'unknown' }])).toEqual([
      { path: 'stays[st-1].rows[rw-2].board', value: null },
    ]);
  });

  it('logs a removed stay by its own ids, and an edit on the next stay keeps that stay\'s ids', () => {
    expect(fieldEventsBetween(READY.refs, [G1, G2, G3], [G3])).toEqual([
      { path: 'stays[st-1].rows[rw-1].removed', value: true },
      { path: 'stays[st-1].removed', value: true },
      { path: 'stays[st-1].rows[rw-2].removed', value: true },
      { path: 'stays[st-1].removed', value: true },
    ]);
    expect(fieldEventsBetween(READY.refs, [G3], [{ ...G3, arrivalDate: '2026-10-30' }])).toEqual([
      { path: 'stays[st-2].requested.arrival', value: '2026-10-30' },
    ]);
  });

  it('removes and puts back the own row of a stay with no rows, so a removed room stays gone on reopen', () => {
    // She copies the room, then removes the original. The copy keeps the stay; the original's own row goes.
    const copy = row('r_ef56', 'st-2', { arrivalDate: '2026-11-01', departureDate: '2026-11-03' });
    expect(fieldEventsBetween(READY.refs, [G3, copy], [copy])).toEqual([
      { path: 'stays[st-2].rows[st-2_row].removed', value: true },
    ]);
    expect(fieldEventsBetween(READY.refs, [copy], [G3, copy]).slice(0, 2)).toEqual([
      { path: 'stays[st-2].rows[st-2_row].removed', value: null },
      { path: 'stays[st-2].rows[st-2_row].count', value: 1 },
    ]);
  });

  it('logs a row she adds under its own id, with the values it has', () => {
    const added = row('r_ab12', 'st-1', { quantity: undefined, adults: undefined, board: 'bb' });
    expect(fieldEventsBetween(READY.refs, [G1, G2], [G1, G2, added])).toEqual([
      { path: 'stays[st-1].rows[r_ab12].removed', value: null },
      { path: 'stays[st-1].rows[r_ab12].childAges', value: [] },
      { path: 'stays[st-1].rows[r_ab12].board', value: 'bb' },
    ]);
  });

  it('logs a new stay with its dates, and an undo puts removed rows back', () => {
    const copy = row('r_cd34_0', 's_cd34');
    expect(fieldEventsBetween(READY.refs, [G1], [G1, copy])).toEqual([
      { path: 'stays[s_cd34].removed', value: null },
      { path: 'stays[s_cd34].requested.arrival', value: '2026-10-12' },
      { path: 'stays[s_cd34].requested.departure', value: '2026-10-14' },
      { path: 'stays[s_cd34].rows[r_cd34_0].removed', value: null },
      { path: 'stays[s_cd34].rows[r_cd34_0].count', value: 1 },
      { path: 'stays[s_cd34].rows[r_cd34_0].adults', value: 2 },
      { path: 'stays[s_cd34].rows[r_cd34_0].childAges', value: [] },
      { path: 'stays[s_cd34].rows[r_cd34_0].board', value: 'bb' },
    ]);
    expect(fieldEventsBetween(READY.refs, [G3], [G1, G3]).slice(0, 2)).toEqual([
      { path: 'stays[st-1].removed', value: null },
      { path: 'stays[st-1].requested.arrival', value: '2026-10-12' },
    ]);
  });

  it('logs nothing for a row with no stable id, such as the blank stay while Nava reads', () => {
    const draft = row(DRAFT_GROUP_ID, 'd:unknown:unknown');
    expect(fieldEventsBetween(READY.refs, [draft], [{ ...draft, arrivalDate: '2026-12-01' }])).toEqual([]);
  });

  describe('a stay total on one row (the default count)', () => {
    // The stored read gave the stay 6 rooms and no count for its one row, so the row's count is the total by default.
    const TOTAL_ROW = row('g1', 'st-1', { quantity: 6, fields: { quantity: 'defaulted' } });
    function withTotal(groups: StayGroupRequirement[]): QuoteSession {
      const analysis = { ...ANALYSIS, requestedRoomsByStay: { 'st-1': 6 } } as unknown as QuoteAnalysis;
      return { ...initialQuoteSession(), groups, analysis };
    }

    it('saves no count when adding a row moves the total off the row', () => {
      const session = withTotal([TOTAL_ROW]);
      const added = reduceQuoteSession(session, { type: 'add_row', stayId: 'st-1', token: 'ab12' });
      expect(fieldEventsBetween(READY.refs, session.groups, added.groups)).toEqual([
        { path: 'stays[st-1].rows[r_ab12].removed', value: null },
        { path: 'stays[st-1].rows[r_ab12].childAges', value: [] },
        { path: 'stays[st-1].rows[r_ab12].board', value: 'bb' },
      ]);
    });

    it('saves no count when duplicating the row moves the total off the original', () => {
      const session = withTotal([TOTAL_ROW]);
      const copied = reduceQuoteSession(session, { type: 'duplicate_row', groupId: 'g1', token: 'ef56' });
      expect(fieldEventsBetween(READY.refs, session.groups, copied.groups)).toEqual([
        { path: 'stays[st-1].rows[r_ef56].removed', value: null },
        { path: 'stays[st-1].rows[r_ef56].adults', value: 2 },
        { path: 'stays[st-1].rows[r_ef56].childAges', value: [] },
        { path: 'stays[st-1].rows[r_ef56].board', value: 'bb' },
      ]);
    });

    it('saves no count when removing the extra row puts the total back on the row left, and removing is all that is saved', () => {
      const session = withTotal([TOTAL_ROW]);
      const added = reduceQuoteSession(session, { type: 'add_row', stayId: 'st-1', token: 'ab12' });
      const removed = reduceQuoteSession(added, { type: 'remove_row', groupId: 'r_ab12' });
      expect(removed.groups.find((group) => group.id === 'g1')).toMatchObject({
        quantity: 6,
        fields: { quantity: 'defaulted' },
      });
      expect(fieldEventsBetween(READY.refs, added.groups, removed.groups)).toEqual([
        { path: 'stays[st-1].rows[r_ab12].removed', value: true },
      ]);
    });

    it('saves no count when she adds a row again after the total came back, so the total moves off the row', () => {
      const session = withTotal([TOTAL_ROW]);
      const added = reduceQuoteSession(session, { type: 'add_row', stayId: 'st-1', token: 'ab12' });
      const removed = reduceQuoteSession(added, { type: 'remove_row', groupId: 'r_ab12' });
      const again = reduceQuoteSession(removed, { type: 'add_row', stayId: 'st-1', token: 'cd34' });
      expect(fieldEventsBetween(READY.refs, removed.groups, again.groups)).toEqual([
        { path: 'stays[st-1].rows[r_cd34].removed', value: null },
        { path: 'stays[st-1].rows[r_cd34].childAges', value: [] },
        { path: 'stays[st-1].rows[r_cd34].board', value: 'bb' },
      ]);
    });

    it('saves the count she confirms at the same number, and the count she clears', () => {
      const session = withTotal([TOTAL_ROW]);
      const confirmed = reduceQuoteSession(session, { type: 'patch_group', groupId: 'g1', patch: { quantity: 6 } });
      expect(fieldEventsBetween(READY.refs, session.groups, confirmed.groups)).toEqual([
        { path: 'stays[st-1].rows[rw-1].count', value: 6 },
      ]);
      const cleared = reduceQuoteSession(session, { type: 'patch_group', groupId: 'g1', patch: { quantity: undefined } });
      expect(fieldEventsBetween(READY.refs, session.groups, cleared.groups)).toEqual([
        { path: 'stays[st-1].rows[rw-1].count', value: null },
      ]);
    });
  });
});

describe('useStoredWork', () => {
  it('shows a ready read from the server for this mail', async () => {
    const { trpc, query } = fakeTrpc(() => READY);
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1' }));
    await waitFor(() =>
      expect(result.current.pane).toMatchObject({
        state: 'ready',
        kind: 'quote',
        workItemStatus: 'needs_you',
      }),
    );
    expect(query).toHaveBeenCalledWith({ internetMessageId: 'm-1' });
  });

  it('opens a work item once for a stored read that has none, then logs edits against it', async () => {
    const { trpc, query, mutate } = fakeTrpc(() => ({ ...READY, workItemId: null, workItemStatus: null }));
    const open = vi.fn(async (_input: unknown) => READY);
    const routes = { workItems: { ...trpc.workItems, open: { mutate: open } } };
    const { result, unmount } = renderHook(() => useStoredWork({ trpc: routes, internetMessageId: 'm-1' }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-1' }));
    expect(query).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ internetMessageId: 'm-1' });
    act(() => result.current.recordGroups([G1], [{ ...G1, quantity: 3 }]));
    unmount();
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ workItemId: 'wi-1', value: 3 }));
  });

  it('can inspect a stored read without opening a new work item', async () => {
    const { trpc } = fakeTrpc(() => ({ ...READY, workItemId: null, workItemStatus: null }));
    const open = vi.fn(async (_input: unknown) => READY);
    const routes = { workItems: { ...trpc.workItems, open: { mutate: open } } };
    const { result } = renderHook(() => useStoredWork({
      trpc: routes,
      internetMessageId: 'm-1',
      openMissingWorkItem: false,
    }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    expect(open).not.toHaveBeenCalled();
  });

  it('never opens a work item for a read that has one', async () => {
    const { trpc } = fakeTrpc(() => READY);
    const open = vi.fn(async (_input: unknown) => READY);
    const routes = { workItems: { ...trpc.workItems, open: { mutate: open } } };
    const { result } = renderHook(() => useStoredWork({ trpc: routes, internetMessageId: 'm-1' }));
    await waitFor(() => expect(result.current.pane.state).toBe('ready'));
    expect(open).not.toHaveBeenCalled();
  });

  it('still shows the stored read when its work item cannot be opened, and logs no edit', async () => {
    const { trpc, mutate } = fakeTrpc(() => ({ ...READY, workItemId: null, workItemStatus: null }));
    const open = vi.fn(async (_input: unknown) => {
      throw new Error('blocked by the preview');
    });
    const routes = { workItems: { ...trpc.workItems, open: { mutate: open } } };
    const { result, unmount } = renderHook(() => useStoredWork({ trpc: routes, internetMessageId: 'm-1' }));
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null }));
    act(() => result.current.recordGroups([G1], [{ ...G1, quantity: 3 }]));
    act(() => result.current.recordContact('phone', '+27 82 555 0100'));
    unmount();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('reads live when nothing is stored', async () => {
    const { trpc } = fakeTrpc(() => ({ status: 'none' }));
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1' }));
    await waitFor(() => expect(result.current.pane.state).toBe('reading'));
  });

  it('reads live when the work item route is missing', async () => {
    const { result } = renderHook(() => useStoredWork({ trpc: {}, internetMessageId: 'm-1' }));
    await waitFor(() => expect(result.current.pane.state).toBe('reading'));
  });

  it('keeps a stored failure until the person retries, then reads live', async () => {
    const { trpc } = fakeTrpc(() => ({ status: 'failed', reason: 'The read timed out.' }));
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1' }));
    await waitFor(() => expect(result.current.pane.state).toBe('failed'));
    expect(result.current.pane).toEqual({ state: 'failed', reason: 'The read timed out.' });
    const failedKey = result.current.key;
    act(() => result.current.retry());
    expect(result.current.pane.state).toBe('reading');
    expect(result.current.key).not.toBe(failedKey);
  });

  it('gives up on a stored read that is slow and reads live', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { trpc } = fakeTrpc(() => new Promise(() => undefined));
      const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1' }));
      expect(result.current.pane.state).toBe('loading');
      act(() => {
        vi.advanceTimersByTime(STORED_LOOKUP_TIMEOUT_MS);
      });
      expect(result.current.pane.state).toBe('reading');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the stored read when opening its work item is slow, and logs no edit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { trpc, mutate } = fakeTrpc(() => ({ ...READY, workItemId: null, workItemStatus: null }));
      const open = vi.fn((_input: unknown) => new Promise<never>(() => undefined));
      const routes = { workItems: { ...trpc.workItems, open: { mutate: open } } };
      const { result, unmount } = renderHook(() => useStoredWork({ trpc: routes, internetMessageId: 'm-1' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(open).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STORED_LOOKUP_TIMEOUT_MS * 2);
      });
      expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: null });
      act(() => result.current.recordGroups([G1], [{ ...G1, quantity: 3 }]));
      unmount();
      expect(mutate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs five quick edits to one field as one event after the quiet period', async () => {
    const { trpc, mutate } = fakeTrpc(() => READY);
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1' }));
    await waitFor(() => expect(result.current.pane.state).toBe('ready'));
    act(() => {
      for (const quantity of [2, 3, 4, 5, 6]) result.current.recordGroups([G1], [{ ...G1, quantity }]);
    });
    expect(mutate).not.toHaveBeenCalled();
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1), { timeout: WORK_EVENT_DEBOUNCE_MS + 2000 });
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: 'wi-1',
        type: 'field.edit',
        fieldPath: 'stays[st-1].rows[rw-1].count',
        value: 6,
        msSinceOpen: expect.any(Number),
      }),
    );
  });

  it('sends a pending edit at once when the pane unmounts', async () => {
    const { trpc, mutate } = fakeTrpc(() => READY);
    const { result, unmount } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1' }));
    await waitFor(() => expect(result.current.pane.state).toBe('ready'));
    act(() => result.current.recordGroups([G2], [{ ...G2, adults: 3 }]));
    unmount();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ fieldPath: 'stays[st-1].rows[rw-2].adults', value: 3 }),
    );
  });

  it('tries a failed send once more, then shows the save failure until a retry lands', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { trpc, mutate } = fakeTrpc(() => READY);
      mutate.mockRejectedValue(new Error('offline'));
      const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.pane.state).toBe('ready');
      act(() => result.current.recordGroups([G1], [{ ...G1, quantity: 4 }]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORK_EVENT_DEBOUNCE_MS);
      });
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(result.current.saveFailed).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORK_EVENT_RETRY_MS);
      });
      expect(mutate).toHaveBeenCalledTimes(2);
      expect(result.current.saveFailed).toBe(true);

      mutate.mockResolvedValue({ aiValue: null, value: null });
      await act(async () => {
        result.current.retrySave();
        await Promise.resolve();
      });
      expect(mutate).toHaveBeenCalledTimes(3);
      expect(mutate).toHaveBeenLastCalledWith(
        expect.objectContaining({ fieldPath: 'stays[st-1].rows[rw-1].count', value: 4 }),
      );
      expect(result.current.saveFailed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never accepts a field she edited, while its first save is failing and waiting for the retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { trpc, mutate } = fakeTrpc(() => READY);
      mutate.mockRejectedValueOnce(new Error('offline'));
      const acceptFields = vi.fn(async (_input: unknown, _opts?: unknown) => ({ accepted: 1 }));
      const routes = { workItems: { ...trpc.workItems, acceptFields: { mutate: acceptFields } } };
      const { result } = renderHook(() => useStoredWork({ trpc: routes, internetMessageId: 'm-1' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.pane.state).toBe('ready');

      act(() => result.current.recordGroups([G1], [{ ...G1, quantity: 4 }]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORK_EVENT_DEBOUNCE_MS);
      });
      expect(mutate).toHaveBeenCalledTimes(1);

      act(() => result.current.acceptUnedited([G1, G2, G3]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(acceptFields).toHaveBeenCalledTimes(1);
      const { fieldPaths } = acceptFields.mock.calls[0]![0] as { fieldPaths: string[] };
      expect(fieldPaths).not.toContain('stays[st-1].rows[rw-1].count');
      expect(fieldPaths).toContain('stays[st-1].rows[rw-1].adults');
      expect(fieldPaths).toContain('stays[st-1].rows[rw-2].count');
      expect(fieldPaths).toContain('stays[st-2].requested.arrival');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never accepts a field she edits while the accept waits for a save in flight', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { trpc, mutate } = fakeTrpc(() => READY);
      // The first save stays in flight until the test lets it finish.
      let finishFirstSave: () => void = () => undefined;
      mutate.mockImplementationOnce(
        () =>
          new Promise<{ aiValue: null; value: null }>((resolve) => {
            finishFirstSave = () => resolve({ aiValue: null, value: null });
          }),
      );
      const acceptFields = vi.fn(async (_input: unknown, _opts?: unknown) => ({ accepted: 1 }));
      const routes = { workItems: { ...trpc.workItems, acceptFields: { mutate: acceptFields } } };
      const { result } = renderHook(() => useStoredWork({ trpc: routes, internetMessageId: 'm-1' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.pane.state).toBe('ready');

      act(() => result.current.recordGroups([G1], [{ ...G1, quantity: 4 }]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORK_EVENT_DEBOUNCE_MS);
      });
      expect(mutate).toHaveBeenCalledTimes(1);

      // The accept waits for the save in flight. She edits the second row while it waits.
      act(() => result.current.acceptUnedited([G1, G2, G3]));
      act(() => result.current.recordGroups([G2], [{ ...G2, quantity: 3 }]));
      await act(async () => {
        finishFirstSave();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(acceptFields).toHaveBeenCalledTimes(1);
      const { fieldPaths } = acceptFields.mock.calls[0]![0] as { fieldPaths: string[] };
      expect(fieldPaths).not.toContain('stays[st-1].rows[rw-1].count');
      expect(fieldPaths).not.toContain('stays[st-1].rows[rw-2].count');
      expect(fieldPaths).toContain('stays[st-1].rows[rw-1].adults');
      expect(fieldPaths).toContain('stays[st-2].requested.arrival');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends one field\'s edits in order, so a slow older save never lands after a newer one', async () => {
    const { trpc, mutate } = fakeTrpc(() => READY);
    const done: Array<() => void> = [];
    mutate.mockImplementation(
      (_input: unknown) => new Promise((resolve) => done.push(() => resolve({ aiValue: null, value: null }))),
    );
    const { result, unmount } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1' }));
    await waitFor(() => expect(result.current.pane.state).toBe('ready'));
    act(() => result.current.recordGroups([G1], [{ ...G1, quantity: 4 }]));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1), { timeout: WORK_EVENT_DEBOUNCE_MS + 2000 });
    // The first save is still out when the next quiet period ends.
    act(() => result.current.recordGroups([G1], [{ ...G1, quantity: 5 }]));
    unmount();
    expect(mutate).toHaveBeenCalledTimes(1);
    await act(async () => {
      done[0]!();
      await Promise.resolve();
    });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    expect(mutate).toHaveBeenLastCalledWith(expect.objectContaining({ fieldPath: 'stays[st-1].rows[rw-1].count', value: 5 }));
  });

  it('saves a correction queued across a mailbox switch to the mailbox that owns its work item', async () => {
    setMailCacheScope({ userId: 'user', activeTransportId: 'transport-a' });
    try {
      const { trpc, mutate } = fakeTrpc(() => READY);
      const done: Array<() => void> = [];
      mutate.mockImplementation(
        (_input: unknown) => new Promise((resolve) => done.push(() => resolve({ aiValue: null, value: null }))),
      );
      const { result, rerender } = renderHook(
        ({ scope }: { scope: string }) => useStoredWork({ trpc, internetMessageId: 'm-1', scope }),
        { initialProps: { scope: 'user:session:transport-a' } },
      );
      await waitFor(() => expect(result.current.pane.state).toBe('ready'));
      act(() => result.current.recordGroups([G1], [{ ...G1, quantity: 4 }]));
      await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1), { timeout: WORK_EVENT_DEBOUNCE_MS + 2000 });
      // The first save is still out; she corrects the field again, then switches mailbox, which flushes it.
      act(() => result.current.recordGroups([G1], [{ ...G1, quantity: 5 }]));
      setMailCacheScope({ userId: 'user', activeTransportId: 'transport-b' });
      rerender({ scope: 'user:session:transport-b' });
      await act(async () => {
        done[0]!();
        await Promise.resolve();
      });
      await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
      expect(mutate.mock.calls[1]).toEqual([
        expect.objectContaining({ workItemId: 'wi-1', value: 5 }),
        { context: { activeTransportId: 'transport-a' } },
      ]);
      // When the call goes out, its pinned mailbox wins over the active one; an unpinned call uses the active one.
      expect(transportForCall((mutate.mock.calls[1]![1] as { context: Record<string, unknown> }).context)).toBe(
        'transport-a',
      );
      expect(transportForCall({})).toBe('transport-b');
    } finally {
      setMailCacheScope({ userId: null, activeTransportId: null });
    }
  });

  it('keeps a failed save on one mail when the same field is edited on another', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { trpc, mutate } = fakeTrpc(() => READY);
      mutate.mockRejectedValue(new Error('offline'));
      const { result, rerender } = renderHook(
        ({ id }: { id: string }) => useStoredWork({ trpc, internetMessageId: id }),
        { initialProps: { id: 'm-1' } },
      );
      await act(async () => {
        await Promise.resolve();
      });
      act(() => result.current.recordContact('phone', '+27 82 555 0100'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORK_EVENT_DEBOUNCE_MS + WORK_EVENT_RETRY_MS);
      });
      expect(result.current.saveFailed).toBe(true);

      // Mail B is another work item. Editing its phone must not drop mail A's unsaved phone.
      const other = { ...READY, workItemId: 'wi-2' };
      (trpc.workItems.getByMessage.query as ReturnType<typeof vi.fn>).mockImplementation(async () => other);
      rerender({ id: 'm-2' });
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-2' });
      act(() => result.current.recordContact('phone', '+27 11 000 0000'));
      expect(result.current.saveFailed).toBe(true);

      mutate.mockResolvedValue({ aiValue: null, value: null });
      await act(async () => {
        result.current.retrySave();
        await Promise.resolve();
      });
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({ workItemId: 'wi-1', fieldPath: 'contact.phone', value: '+27 82 555 0100' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('looks the mail up again when the mailbox changes, so another mailbox\'s work item is never shown', async () => {
    const { trpc, query } = fakeTrpc(() => READY);
    const { result, rerender } = renderHook(
      ({ scope }: { scope: string }) => useStoredWork({ trpc, internetMessageId: 'm-1', scope }),
      { initialProps: { scope: 'user:session:transport-a' } },
    );
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-1' }));
    query.mockImplementation(async () => ({ ...READY, workItemId: 'wi-b' }));
    rerender({ scope: 'user:session:transport-b' });
    expect(result.current.pane.state).toBe('loading');
    await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-b' }));
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('opens a missing work item in the mailbox its lookup was made in', async () => {
    setMailCacheScope({ userId: 'user', activeTransportId: 'transport-a' });
    try {
      const { trpc } = fakeTrpc(() => ({ ...READY, workItemId: null, workItemStatus: null }));
      const open = vi.fn(async (_input: unknown, _opts?: unknown) => READY);
      const routes = { workItems: { ...trpc.workItems, open: { mutate: open } } };
      const { result } = renderHook(() =>
        useStoredWork({ trpc: routes, internetMessageId: 'm-1', scope: 'user:session:transport-a' }),
      );
      await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-1' }));
      expect(open.mock.calls).toEqual([[{ internetMessageId: 'm-1' }, { context: { activeTransportId: 'transport-a' } }]]);
    } finally {
      setMailCacheScope({ userId: null, activeTransportId: null });
    }
  });

  it('never opens a work item in the mailbox switched to while the lookup was out', async () => {
    setMailCacheScope({ userId: 'user', activeTransportId: 'transport-a' });
    try {
      const { trpc, query } = fakeTrpc(() => READY);
      let answerA: (work: StoredWork) => void = () => undefined;
      query.mockImplementationOnce(() => new Promise<StoredWork>((resolve) => (answerA = resolve)));
      const open = vi.fn(async (_input: unknown, _opts?: unknown) => READY);
      const routes = { workItems: { ...trpc.workItems, open: { mutate: open } } };
      const { result, rerender } = renderHook(
        ({ scope }: { scope: string }) => useStoredWork({ trpc: routes, internetMessageId: 'm-1', scope }),
        { initialProps: { scope: 'user:session:transport-a' } },
      );
      // Mailbox A's lookup is out, pinned to A. She switches to mailbox B, whose lookup finds its own work item.
      expect(query.mock.calls[0]).toEqual([{ internetMessageId: 'm-1' }, { context: { activeTransportId: 'transport-a' } }]);
      setMailCacheScope({ userId: 'user', activeTransportId: 'transport-b' });
      rerender({ scope: 'user:session:transport-b' });
      await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready', workItemId: 'wi-1' }));
      // A's read comes back late with no work item: no open goes out under B (the shared Message-ID's other mailbox).
      await act(async () => {
        answerA({ ...READY, workItemId: null, workItemStatus: null });
        await Promise.resolve();
      });
      expect(open).not.toHaveBeenCalled();
    } finally {
      setMailCacheScope({ userId: null, activeTransportId: null });
    }
  });

  it('drops a failed save when a newer edit to the same field replaces it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { trpc, mutate } = fakeTrpc(() => READY);
      mutate.mockRejectedValue(new Error('offline'));
      const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1' }));
      await act(async () => {
        await Promise.resolve();
      });
      act(() => result.current.recordGroups([G1], [{ ...G1, quantity: 4 }]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORK_EVENT_DEBOUNCE_MS + WORK_EVENT_RETRY_MS);
      });
      expect(result.current.saveFailed).toBe(true);
      act(() => result.current.recordGroups([G1], [{ ...G1, quantity: 6 }]));
      expect(result.current.saveFailed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs nothing for edits made while the read is live', async () => {
    const { trpc, mutate } = fakeTrpc(() => ({ status: 'none' }));
    const { result, unmount } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1' }));
    await waitFor(() => expect(result.current.pane.state).toBe('reading'));
    act(() => result.current.recordGroups([G1], [{ ...G1, quantity: 3 }]));
    unmount();
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('the form while Nava reads', () => {
  it('shows an editable blank stay under the reading copy, and lays her edit over the read that lands', () => {
    const onPatchGroup = vi.fn();
    const reading = reduceQuoteSession(initialQuoteSession(), { type: 'analysis_started' });
    render(<QuoteWorkflowPanel session={reading} onPatchGroup={onPatchGroup} />);
    expect(screen.getByText(/Nava is reading the email/i)).toBeDefined();
    fireEvent.change(screen.getByLabelText(/Arrival/i), { target: { value: '2026-11-03' } });
    expect(onPatchGroup).toHaveBeenCalledWith(DRAFT_GROUP_ID, expect.objectContaining({ arrivalDate: '2026-11-03' }));
    cleanup();

    const edited = reduceQuoteSession(reading, {
      type: 'patch_group',
      groupId: DRAFT_GROUP_ID,
      patch: { arrivalDate: '2026-11-03' },
    });
    expect(edited.groups).toHaveLength(1);
    expect(edited.groups[0]).toMatchObject({ id: DRAFT_GROUP_ID, arrivalDate: '2026-11-03' });
    const landed = reduceQuoteSession(edited, {
      type: 'analysis_ready',
      analysis: {
        intent: 'quote',
        groups: [
          { id: 'g1', arrivalDate: '2026-12-01', childrenAges: [], board: 'bb', specialRequests: [], fields: {} },
        ],
        secondaryAsks: [],
        alternatives: [],
      },
    });
    expect(landed.groups).toHaveLength(1);
    expect(landed.groups[0]).toMatchObject({ id: 'g1', arrivalDate: '2026-11-03', board: 'bb' });
    expect(landed.groups[0]!.fields.arrivalDate).toBe('staff_corrected');
    expect(landed.inputRevision).toBeGreaterThan(edited.inputRevision);
  });

  it('keeps the blank stay editable after a failed read', () => {
    const failed = reduceQuoteSession(reduceQuoteSession(initialQuoteSession(), { type: 'analysis_started' }), {
      type: 'analysis_failed',
      message: 'Nava ran out of time reading this email.',
    });
    const onRetryRead = vi.fn();
    render(<QuoteWorkflowPanel session={failed} onPatchGroup={vi.fn()} onRetryRead={onRetryRead} />);
    expect(screen.getByLabelText(/Arrival/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry reading this email' }));
    expect(onRetryRead).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
