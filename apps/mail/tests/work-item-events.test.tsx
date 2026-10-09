/**
 * @vitest-environment happy-dom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StoredWork } from '@/lib/quote-workflow/backend-bind';
import {
  fieldEventsFor,
  STORED_LOOKUP_TIMEOUT_MS,
  stayDatesOf,
  storedDecision,
  useStoredWork,
  WORK_EVENT_DEBOUNCE_MS,
  type StoredPane,
} from '@/lib/quote-workflow/use-work-item';

type Ready = Extract<StoredWork, { status: 'ready' }>;

const ANALYSIS = { intent: 'quote', groups: [], secondaryAsks: [], alternatives: [] } as unknown as Ready['analysis'];

const READY: Ready = {
  status: 'ready',
  workItemId: 'wi-1',
  workItemStatus: 'needs_you',
  extractionId: 'ex-1',
  refs: {
    g1: { stayId: 'st-1', rowId: 'rw-1' },
    g2: { stayId: 'st-1', rowId: 'rw-2' },
    g3: { stayId: 'st-2', rowId: null },
  },
  analysis: ANALYSIS,
};

function fakeTrpc(lookup: () => unknown) {
  const query = vi.fn(async (_input: unknown) => lookup());
  const mutate = vi.fn(async (_input: unknown) => ({ aiValue: null, value: null }));
  return { trpc: { workItems: { getByMessage: { query }, recordEvent: { mutate } } }, query, mutate };
}

describe('storedDecision', () => {
  const ready: StoredPane = { state: 'ready', analysis: ANALYSIS, workItemId: 'wi-1' };

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

describe('fieldEventsFor', () => {
  it('maps a row group to its stable stay and row ids', () => {
    expect(fieldEventsFor(READY.refs, 'g1', { arrivalDate: '2026-10-12', quantity: 2, board: 'dinner_bb' })).toEqual([
      { path: 'stays[st-1].requested.arrival', value: '2026-10-12' },
      { path: 'stays[st-1].rows[rw-1].count', value: 2 },
      { path: 'stays[st-1].rows[rw-1].board', value: 'dbb' },
    ]);
  });

  it('logs stay dates only for a stay with no row', () => {
    expect(fieldEventsFor(READY.refs, 'g3', { departureDate: '2026-10-14', quantity: 2 })).toEqual([
      { path: 'stays[st-2].requested.departure', value: '2026-10-14' },
    ]);
  });

  it('states an unknown board as null', () => {
    expect(fieldEventsFor(READY.refs, 'g2', { board: 'unknown' })).toEqual([
      { path: 'stays[st-1].rows[rw-2].board', value: null },
    ]);
  });

  it('keeps a stay on its own id when another stay is gone', () => {
    const afterDelete = { g3: { stayId: 'st-2', rowId: null } };
    expect(fieldEventsFor(afterDelete, 'g3', { arrivalDate: '2026-10-12' })).toEqual([
      { path: 'stays[st-2].requested.arrival', value: '2026-10-12' },
    ]);
  });

  it('logs nothing for a group the stored read does not know', () => {
    expect(fieldEventsFor(READY.refs, 'g9', { quantity: 2 })).toEqual([]);
  });
});

describe('stayDatesOf', () => {
  it('keeps the two stay dates and drops the room fields', () => {
    expect(stayDatesOf({ arrivalDate: '2026-10-12', quantity: 2, roomPreference: 'Twin' })).toEqual({
      arrivalDate: '2026-10-12',
    });
  });
});

describe('useStoredWork', () => {
  it('shows a ready read from the server for this mail, with its sibling groups', async () => {
    const { trpc, query } = fakeTrpc(() => READY);
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1' }));
    await waitFor(() => expect(result.current.pane.state).toBe('ready'));
    expect(query).toHaveBeenCalledWith({ internetMessageId: 'm-1' });
    expect(result.current.siblingGroupIds('g1')).toEqual(['g2']);
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

  it('logs five quick edits to one field as one event after the quiet period', async () => {
    const { trpc, mutate } = fakeTrpc(() => READY);
    const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1' }));
    await waitFor(() => expect(result.current.pane.state).toBe('ready'));
    act(() => {
      for (const quantity of [1, 2, 3, 4, 5]) result.current.recordGroupPatch('g1', { quantity });
    });
    expect(mutate).not.toHaveBeenCalled();
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1), { timeout: WORK_EVENT_DEBOUNCE_MS + 2000 });
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: 'wi-1',
        type: 'field.edit',
        fieldPath: 'stays[st-1].rows[rw-1].count',
        value: 5,
        msSinceOpen: expect.any(Number),
      }),
    );
  });

  it('sends a pending edit at once when the pane unmounts', async () => {
    const { trpc, mutate } = fakeTrpc(() => READY);
    const { result, unmount } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1' }));
    await waitFor(() => expect(result.current.pane.state).toBe('ready'));
    act(() => result.current.recordGroupPatch('g2', { adults: 2 }));
    unmount();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ fieldPath: 'stays[st-1].rows[rw-2].adults', value: 2 }),
    );
  });

  it('logs nothing for edits made while the read is live', async () => {
    const { trpc, mutate } = fakeTrpc(() => ({ status: 'none' }));
    const { result, unmount } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm-1' }));
    await waitFor(() => expect(result.current.pane.state).toBe('reading'));
    act(() => result.current.recordGroupPatch('g1', { quantity: 3 }));
    unmount();
    expect(mutate).not.toHaveBeenCalled();
  });
});
