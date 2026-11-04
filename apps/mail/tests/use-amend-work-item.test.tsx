/** @vitest-environment happy-dom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAmendWorkItem } from '../lib/quote-workflow/use-amend-work-item';
import type { AmendDraftSnapshot } from '../lib/quote-workflow/backend-bind';

afterEach(cleanup);

function snapshot(id: string): AmendDraftSnapshot {
  return {
    workItemId: `work-${id}`, revisionSeq: 0, fieldMeta: {},
    source: { threadId: `thread-${id}`, messageId: `mail-${id}`, sourceHash: id, extractionId: `extract-${id}` },
    requests: [{ requestId: `request-${id}`, stayId: 'stay', fields: { kind: 'amend', value: {
      target: null, arrival: null, departure: null, adults: null, children: null, childAges: null,
      roomType: null, ratePlan: null, retainRates: null, firstName: null, lastName: null, guestEmail: null,
      bookerName: null, bookerContact: null, cms: { send: null, messageId: null, recipient: null },
    } } }],
  };
}

it('lets staff retry an unsaved amendment after switching email while a save fails', async () => {
  const a = snapshot('a');
  const b = snapshot('b');
  let rejectSave!: (error: Error) => void;
  const mutate = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }))
    .mockResolvedValue({ seq: 1, revision: 1, revisionHead: 1, workItemExtractionId: 'extract-a' });
  const reloadA = vi.fn().mockResolvedValue(a);
  const reloadB = vi.fn().mockResolvedValue(b);
  const trpc = { workItems: { recordEvent: { mutate } } };
  const onSave = vi.fn();
  const { result, rerender } = renderHook(({ current }) => useAmendWorkItem({
    trpc, snapshot: current, transportId: 'transport', reload: current === a ? reloadA : reloadB, onSave,
  }), { initialProps: { current: a } });

  act(() => { result.current.record('adults', 3); void result.current.flush(); });
  rerender({ current: b });
  await act(async () => { rejectSave(new Error('offline')); await Promise.resolve(); });
  expect(reloadB).not.toHaveBeenCalled();
  rerender({ current: a });
  expect(result.current.retryable).toBe(true);
  act(() => result.current.retry());
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(reloadA).toHaveBeenCalledTimes(1);
  expect(mutate).toHaveBeenLastCalledWith(expect.objectContaining({ workItemId: 'work-a', value: 3 }), expect.anything());
});
