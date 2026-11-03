/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThreadDisplay } from '@/components/mail/thread-display';
import { focusedIndexAtom } from '@/hooks/use-mail-navigation';
import { getDefaultStore } from 'jotai';

const mocks = vi.hoisted(() => ({
  thread: { transportId: 'transport-1', messages: [] as any[], latest: undefined as any },
  setMailSelection: vi.fn(),
  flushCompose: vi.fn(),
  optimisticMove: vi.fn(),
  clearSelection: null as (() => void) | null,
  items: [] as Array<{ id: string }>,
}));

vi.mock('nuqs', async () => {
  const { useState } = await import('react');
  return {
    parseAsString: {},
    useQueryState: () => [null, vi.fn()],
    useQueryStates: (shape: Record<string, unknown>) => {
      const [selection, setSelection] = useState<{ threadId: string | null; sourceMessageId: string | null }>({
        threadId: 'thread-a', sourceMessageId: null,
      });
      if (!('threadId' in shape)) return [{}, vi.fn()];
      mocks.clearSelection = () => setSelection({ threadId: null, sourceMessageId: null });
      return [selection, (value: typeof selection) => {
        mocks.setMailSelection(value);
        setSelection(value);
        return Promise.resolve(value);
      }];
    },
  };
});
vi.mock('@/hooks/use-threads', () => ({
  useThread: () => ({ data: mocks.thread, isLoading: false, isFetching: false, isThreadDataMismatch: false,
    refetch: vi.fn(), latestDraft: null, aiDraftCandidates: [] }),
  useThreads: () => [{}, mocks.items],
}));
vi.mock('@/hooks/use-connections', () => ({
  useActiveConnection: () => ({ data: { id: 'transport-1', email: 'staff@example.com' } }),
}));
vi.mock('@/lib/mail/compose-flush-registry', () => ({ flushComposeBeforeLeave: () => mocks.flushCompose() }));
vi.mock('@/hooks/use-timezone', () => ({ useTimezone: () => 'UTC' }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/use-animations', () => ({ useAnimations: () => false }));
vi.mock('@/hooks/use-labels', () => ({ useLabels: () => ({ userLabels: [] }) }));
vi.mock('@/lib/auth-client', () => ({ useSession: () => ({ data: { user: { id: 'staff' } } }) }));
vi.mock('@/lib/demo/runtime', () => ({ isFrontendOnlyDemo: () => false }));
vi.mock('@/hooks/use-optimistic-actions', () => ({ useOptimisticActions: () => ({
  optimisticMoveThreadsTo: (...args: unknown[]) => mocks.optimisticMove(...args), optimisticToggleStar: vi.fn(),
  optimisticToggleImportant: vi.fn(), optimisticDeleteDraft: vi.fn(),
}) }));
vi.mock('@/components/mail/optimistic-thread-state', () => ({
  useOptimisticThreadState: () => ({ shouldHide: false, optimisticImportant: null }),
}));
vi.mock('@/providers/query-provider', () => ({ useTRPC: () => ({ ai: {
  hmsCandidateState: { queryOptions: () => ({}) }, refreshHmsCandidate: { mutationOptions: () => ({}) },
} }) }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: null, refetch: vi.fn() }),
  useMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('react-router', () => ({ useParams: () => ({ folder: 'inbox' }) }));
vi.mock('@/paraglide/messages', () => ({ m: new Proxy({}, { get: (_, key) => () => key === 'common.actions.close' ? 'Close' : String(key) }) }));
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => children, TooltipProvider: ({ children }: any) => children,
  TooltipTrigger: ({ children }: any) => children, TooltipContent: () => null,
}));
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: any) => children, DropdownMenuTrigger: ({ children }: any) => children,
  DropdownMenuContent: () => null, DropdownMenuItem: ({ children }: any) => children,
}));
vi.mock('@/components/ui/scroll-area', () => ({ ScrollArea: ({ children }: any) => <div>{children}</div> }));
vi.mock('@/components/mail/mail-display', () => ({ default: () => null, ThreadAttachments: () => null }));
vi.mock('@/components/mail/reply-composer', () => ({ default: () => null }));
vi.mock('@/components/mail/note-panel', () => ({ NotesPanel: () => null }));

afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.items = []; mocks.clearSelection = null; });

it('finishes a pending close when a single inbound message arrives during draft save', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  let finishSave!: () => void;
  mocks.flushCompose.mockReturnValue(new Promise<void>((resolve) => { finishSave = resolve; }));
  mocks.thread = { transportId: 'transport-1', messages: [], latest: undefined };
  const { rerender } = render(<ThreadDisplay />);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(mocks.flushCompose).toHaveBeenCalledOnce();

  const email = { id: 'message-a', threadId: 'thread-a', direction: 'inbound', isDraft: false,
    sender: { email: 'guest@example.com' }, to: [{ email: 'staff@example.com' }], tags: [],
    receivedOn: '2026-11-01T12:00:00.000Z', subject: 'A', attachments: [] };
  mocks.thread = { transportId: 'transport-1', messages: [email], latest: email };
  rerender(<ThreadDisplay />);
  expect(mocks.setMailSelection).not.toHaveBeenCalled();
  await act(async () => finishSave());
  await waitFor(() => expect(mocks.setMailSelection).toHaveBeenCalledWith({ threadId: null, sourceMessageId: null }));
});

it('opens the next thread after a move clears the old selection', async () => {
  mocks.items = [{ id: 'thread-a' }, { id: 'thread-b' }];
  mocks.thread = { transportId: 'transport-1', messages: [], latest: undefined };
  mocks.flushCompose.mockResolvedValue(undefined);
  mocks.optimisticMove.mockImplementation(() => mocks.clearSelection?.());
  getDefaultStore().set(focusedIndexAtom, 0);
  render(<ThreadDisplay />);
  fireEvent.click(screen.getByRole('button', { name: 'common.threadDisplay.archive' }));
  await waitFor(() => expect(mocks.setMailSelection).toHaveBeenCalledWith({ threadId: 'thread-b', sourceMessageId: null }));
  expect(mocks.optimisticMove).toHaveBeenCalledWith(['thread-a'], 'inbox', 'archive');
  expect(mocks.flushCompose).toHaveBeenCalledOnce();
});
