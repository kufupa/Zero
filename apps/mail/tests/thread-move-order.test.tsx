/** @vitest-environment happy-dom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useOptimisticActions } from '@/hooks/use-optimistic-actions';
import { optimisticActionsManager } from '@/lib/optimistic-actions-manager';

const mocks = vi.hoisted(() => ({
  move: vi.fn(async () => ({ preferences: [] })),
  refresh: vi.fn(async () => {}),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock('@/lib/thread-actions', () => ({
  moveThreadsTo: mocks.move, fileThreadsTo: vi.fn(), buildThreadFilingSnapshots: vi.fn(),
  collectCachedThreadLabelSources: vi.fn(),
}));
vi.mock('@/providers/query-provider', () => ({ useTRPC: () => {
  const endpoint = { mutationOptions: () => ({}), queryKey: () => ['test'] };
  const group = new Proxy({}, { get: () => endpoint });
  return { mail: group, drafts: group, categories: group, labels: group };
} }));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync: vi.fn() }),
  useQueryClient: () => ({ refetchQueries: mocks.refresh }),
}));
vi.mock('jotai', async (original) => ({
  ...await original<typeof import('jotai')>(), useAtom: () => [null, vi.fn(() => 'optimistic-id')],
}));
vi.mock('nuqs', () => ({ useQueryState: () => [null, vi.fn()] }));
vi.mock('@/components/mail/use-mail', () => ({ useMail: () => [{ bulkSelected: [] }, vi.fn()] }));
vi.mock('@/hooks/use-labels', () => ({ useLabels: () => ({ userLabels: [] }) }));
vi.mock('@/lib/demo/runtime', () => ({ isFrontendOnlyDemo: () => false }));
vi.mock('@/lib/mail/spam-undo-toast', () => ({ showSpamUndoToast: vi.fn() }));
vi.mock('@/paraglide/messages', () => ({ m: new Proxy({}, { get: (_, key) => () => String(key) }) }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('sonner', () => ({ toast: mocks.toast }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('does not send an older delayed archive after a newer spam move', async () => {
  const { result } = renderHook(() => useOptimisticActions());
  act(() => result.current.optimisticMoveThreadsTo(['thread-a'], 'inbox', 'archive'));
  const pending = mocks.toast.mock.calls[0]![1] as { onAutoClose: () => void };
  act(() => result.current.optimisticMoveThreadsTo(['thread-a'], 'inbox', 'spam'));
  await waitFor(() => expect(mocks.move).toHaveBeenCalledWith({
    threadIds: ['thread-a'], currentFolder: 'inbox', destination: 'spam',
  }));
  await act(async () => { pending.onAutoClose(); });
  await waitFor(() => expect(optimisticActionsManager.pendingActions.size).toBe(0));
  expect(mocks.move).toHaveBeenCalledOnce();
});

it('still archives unaffected threads in an older bulk move', async () => {
  const { result } = renderHook(() => useOptimisticActions());
  act(() => result.current.optimisticMoveThreadsTo(['thread-a', 'thread-b'], 'inbox', 'archive'));
  const pending = mocks.toast.mock.calls[0]![1] as { onAutoClose: () => void };
  act(() => result.current.optimisticMoveThreadsTo(['thread-a'], 'inbox', 'spam'));
  await waitFor(() => expect(mocks.move).toHaveBeenCalledOnce());
  await act(async () => { pending.onAutoClose(); });
  await waitFor(() => expect(mocks.move).toHaveBeenCalledWith({
    threadIds: ['thread-b'], currentFolder: 'inbox', destination: 'archive',
  }));
  await waitFor(() => expect(optimisticActionsManager.pendingActions.size).toBe(0));
});


it('restores an older pending archive when a newer bin move is undone', async () => {
  const { result } = renderHook(() => useOptimisticActions());
  act(() => result.current.optimisticMoveThreadsTo(['thread-c'], 'inbox', 'archive'));
  const archive = mocks.toast.mock.calls[0]![1] as { onAutoClose: () => void };
  act(() => result.current.optimisticMoveThreadsTo(['thread-c'], 'inbox', 'bin'));
  const bin = mocks.toast.mock.calls[1]![1] as { action: { onClick: () => void } };
  act(() => bin.action.onClick());
  await act(async () => { archive.onAutoClose(); });
  await waitFor(() => expect(mocks.move).toHaveBeenCalledWith({
    threadIds: ['thread-c'], currentFolder: 'inbox', destination: 'archive',
  }));
  expect(mocks.move).toHaveBeenCalledOnce();
});

it('does not revive an older move that already expired when a newer move is undone', async () => {
  const { result } = renderHook(() => useOptimisticActions());
  act(() => result.current.optimisticMoveThreadsTo(['thread-d'], 'inbox', 'archive'));
  const archive = mocks.toast.mock.calls[0]![1] as { onAutoClose: () => void };
  act(() => result.current.optimisticMoveThreadsTo(['thread-d'], 'inbox', 'bin'));
  const bin = mocks.toast.mock.calls[1]![1] as { action: { onClick: () => void } };
  await act(async () => { archive.onAutoClose(); });
  act(() => bin.action.onClick());
  expect(mocks.move).not.toHaveBeenCalled();
});

it('does not send an older archive when a spam request fails after saving', async () => {
  let saved = 'inbox';
  mocks.move.mockImplementationOnce(async () => { saved = 'spam'; throw new Error('reply lost'); });
  const { result } = renderHook(() => useOptimisticActions());
  act(() => result.current.optimisticMoveThreadsTo(['thread-e'], 'inbox', 'archive'));
  const archive = mocks.toast.mock.calls[0]![1] as { onAutoClose: () => void };
  act(() => result.current.optimisticMoveThreadsTo(['thread-e'], 'inbox', 'spam'));
  await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
  await act(async () => { archive.onAutoClose(); });
  await waitFor(() => expect(optimisticActionsManager.pendingActions.size).toBe(0));
  expect(mocks.move).toHaveBeenCalledOnce();
  expect(saved).toBe('spam');
});

it('does not send an older archive when a bin request fails after saving', async () => {
  let saved = 'inbox';
  mocks.move.mockImplementationOnce(async () => { saved = 'bin'; throw new Error('reply lost'); });
  const { result } = renderHook(() => useOptimisticActions());
  act(() => result.current.optimisticMoveThreadsTo(['thread-f'], 'inbox', 'archive'));
  const archive = mocks.toast.mock.calls[0]![1] as { onAutoClose: () => void };
  act(() => result.current.optimisticMoveThreadsTo(['thread-f'], 'inbox', 'bin'));
  const bin = mocks.toast.mock.calls[1]![1] as { onAutoClose: () => void };
  await act(async () => { bin.onAutoClose(); });
  await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
  await act(async () => { archive.onAutoClose(); });
  await waitFor(() => expect(optimisticActionsManager.pendingActions.size).toBe(0));
  expect(mocks.move).toHaveBeenCalledOnce();
  expect(saved).toBe('bin');
});

it('does not revive an older archive when spam saved but refresh failed', async () => {
  mocks.refresh.mockRejectedValueOnce(new Error('refresh failed'));
  const { result } = renderHook(() => useOptimisticActions());
  act(() => result.current.optimisticMoveThreadsTo(['thread-g'], 'inbox', 'archive'));
  const archive = mocks.toast.mock.calls[0]![1] as { onAutoClose: () => void };
  act(() => result.current.optimisticMoveThreadsTo(['thread-g'], 'inbox', 'spam'));
  await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
  await act(async () => { archive.onAutoClose(); });
  await waitFor(() => expect(optimisticActionsManager.pendingActions.size).toBe(0));
  expect(mocks.move).toHaveBeenCalledOnce();
});
