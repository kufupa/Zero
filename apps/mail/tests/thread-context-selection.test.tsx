/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThreadContextMenu } from '@/components/context/thread-context';
import { beginMailSelectionIntent, isCurrentMailSelectionIntent } from '@/lib/mail/source-message-navigation';

const mocks = vi.hoisted(() => ({
  selected: { threadId: 'thread-a', sourceMessageId: 'message-a' },
  setSelection: vi.fn(),
  compose: vi.fn(),
}));
vi.mock('nuqs', () => ({
  parseAsString: {}, useQueryState: () => [null, vi.fn()],
  useQueryStates: (shape: Record<string, unknown>) => 'threadId' in shape
    ? [mocks.selected, mocks.setSelection] : [{}, vi.fn()],
}));
vi.mock('@/lib/mail/reply-compose-context', () => ({ openReplyComposeContext: mocks.compose }));
vi.mock('react-router', () => ({ useParams: () => ({ folder: 'inbox' }) }));
vi.mock('@/components/mail/use-mail', () => ({ useMail: () => [{ bulkSelected: [] }, vi.fn()] }));
vi.mock('@/hooks/use-threads', () => ({
  useThreads: () => [{ isLoading: false, isFetching: false, refetch: vi.fn() }],
  useThread: () => ({ data: { messages: [], latest: { id: 'latest' } } }),
}));
vi.mock('@/hooks/use-labels', () => ({ useLabels: () => ({ userLabels: [], refetch: vi.fn() }) }));
vi.mock('@/hooks/use-optimistic-actions', () => ({ useOptimisticActions: () => ({}) }));
vi.mock('@/components/mail/optimistic-thread-state', () => ({ useOptimisticThreadState: () => ({}) }));
vi.mock('@/providers/query-provider', () => ({ useTRPC: () => {
  const endpoint = { mutationOptions: () => ({}) };
  const group = new Proxy({}, { get: () => endpoint });
  return { mail: group, labels: group };
} }));
vi.mock('@tanstack/react-query', () => ({ useMutation: () => ({ mutateAsync: vi.fn() }) }));
vi.mock('@/paraglide/messages', () => ({ m: new Proxy({}, { get: (_, key) => () => String(key) }) }));
vi.mock('@/components/labels/label-dialog', () => ({ LabelDialog: () => null }));
vi.mock('@/components/mail/snooze-dialog', () => ({ SnoozeDialog: () => null }));
vi.mock('@/components/ui/context-menu', () => {
  const Wrapper = ({ children }: any) => <div>{children}</div>;
  return {
    ContextMenu: Wrapper, ContextMenuContent: Wrapper, ContextMenuTrigger: Wrapper,
    ContextMenuSeparator: () => null, ContextMenuShortcut: Wrapper,
    ContextMenuSub: Wrapper, ContextMenuSubContent: Wrapper, ContextMenuSubTrigger: Wrapper,
    ContextMenuItem: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
  };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each(['common.mail.reply', 'common.mail.replyAll', 'common.mail.forward'])(
  '%s clears another thread’s selected email and cancels older navigation', (label) => {
    const earlier = beginMailSelectionIntent();
    render(<ThreadContextMenu threadId="thread-b"><span>Thread B</span></ThreadContextMenu>);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(mocks.setSelection).toHaveBeenCalledWith({ threadId: 'thread-b', sourceMessageId: null });
    expect(isCurrentMailSelectionIntent(earlier)).toBe(false);
    expect(mocks.compose).toHaveBeenCalledOnce();
  },
);

it('preserves the selected email when composing in the same thread', () => {
  render(<ThreadContextMenu threadId="thread-a"><span>Thread A</span></ThreadContextMenu>);
  fireEvent.click(screen.getByRole('button', { name: 'common.mail.reply' }));
  expect(mocks.setSelection).toHaveBeenCalledWith({ threadId: 'thread-a', sourceMessageId: 'message-a' });
});
